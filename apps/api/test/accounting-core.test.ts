import { randomInt, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inTransaction, setDbContext } from '../src/application/unit-of-work.js';
import { ISO_CURRENCIES, minorUnits } from '../src/domain/money.js';
import {
  cashSale,
  joinWithRole,
  line,
  postJournal,
  setUpAccountingOrg,
  type AccountingOrg,
} from './fixtures.js';
import { connectAs, createTestContext, type TestContext } from './helpers.js';

/**
 * Phase 3A S1 — accounting core: account currency and classification, designations, the FX
 * line model and replaced posting guard, source references, transaction-aware event intake
 * (C1), control accounts (C3) and base-currency changes (Decision 26).
 */

let ctx: TestContext;
const origin = { requestId: null, ipAddress: null, userAgent: null };

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});

async function asOwner<T>(work: (db: pg.Client) => Promise<T>): Promise<T> {
  const db = await connectAs('owner');
  try {
    return await work(db);
  } finally {
    await db.end();
  }
}

/** Runs work as the application role inside a rolled-back transaction with tenant context. */
async function asApp<T>(organizationId: string, work: (db: pg.Client) => Promise<T>): Promise<T> {
  const db = await connectAs('app');
  try {
    await db.query('BEGIN');
    await db.query(`SELECT set_config('app.organization_id', $1, true)`, [organizationId]);
    return await work(db);
  } finally {
    await db.query('ROLLBACK');
    await db.end();
  }
}

async function createAccount(org: AccountingOrg, body: Record<string, unknown>) {
  const response = await org.owner.post('/accounting/accounts', body);
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data as { id: string; currencyCode: string };
}

function periodFor(org: AccountingOrg, date: string) {
  return org.periods.find((p) => p.startDate <= date && date <= p.endDate)!.id;
}

/**
 * Forges a POSTED transition directly in SQL as the application role, bypassing the service,
 * to prove the database guard on its own.
 */
async function forgePost(
  db: pg.Client,
  org: AccountingOrg,
  journalId: string,
  totals: { debit: string; base: string },
) {
  await db.query(
    `UPDATE accounting_journal_entries SET status = 'POSTED', journal_number = $2,
       posted_at = now(), period_id = $3, exchange_rate = 1, base_currency = 'MVR',
       total_debit = $4, total_credit = $4, total_base_debit = $5, total_base_credit = $5
     WHERE id = $1`,
    [
      journalId,
      randomInt(1_000_000, 2_000_000_000),
      periodFor(org, '2026-03-15'),
      totals.debit,
      totals.base,
    ],
  );
}

async function insertDraft(
  db: pg.Client,
  org: AccountingOrg,
  source: 'manual' | 'system',
  sourceType: string | null = null,
) {
  const { rows } = await db.query(
    `INSERT INTO accounting_journal_entries
       (organization_id, entry_date, currency, source, source_module, source_type, source_id)
     VALUES ($1, '2026-03-15', 'MVR', $2, $3, $4, $5) RETURNING id`,
    [
      org.organizationId,
      source,
      sourceType ? 'accounting' : null,
      sourceType,
      sourceType ? randomUUID() : null,
    ],
  );
  return rows[0].id as string;
}

async function insertLine(
  db: pg.Client,
  org: AccountingOrg,
  journalId: string,
  n: number,
  accountId: string,
  kind: 'normal' | 'base_only',
  side: 'debit' | 'credit',
  amount: string | null,
  base: string,
) {
  await db.query(
    `INSERT INTO accounting_journal_lines
       (organization_id, journal_id, line_number, line_kind, account_id, debit, credit, base_debit, base_credit)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      org.organizationId,
      journalId,
      n,
      kind,
      accountId,
      side === 'debit' ? amount : null,
      side === 'credit' ? amount : null,
      side === 'debit' ? base : null,
      side === 'credit' ? base : null,
    ],
  );
}

async function markControl(org: AccountingOrg, code: string) {
  await asOwner((db) =>
    db.query(
      `UPDATE accounting_accounts SET is_control_account = true WHERE organization_id = $1 AND code = $2`,
      [org.organizationId, code],
    ),
  );
}

function systemJournal(
  org: AccountingOrg,
  input: Partial<Parameters<TestContext['services']['journals']['postSystemJournal']>[1]>,
) {
  return inTransaction(ctx.database.db, { organizationId: org.organizationId }, async (tx) => {
    await setDbContext(tx, { organizationId: org.organizationId });
    return ctx.services.journals.postSystemJournal(
      tx,
      {
        organizationId: org.organizationId,
        userId: null,
        source: { module: 'accounting', type: 'revaluation', id: randomUUID() },
        entryDate: '2026-03-31',
        description: 'System journal',
        reference: '',
        currency: 'MVR',
        exchangeRate: null,
        lines: [],
        ...input,
      },
      origin,
    );
  });
}

function baseOnly(accountId: string, side: 'debit' | 'credit', amount: string) {
  return {
    accountId,
    description: '',
    kind: 'base_only' as const,
    debit: null,
    credit: null,
    baseDebit: side === 'debit' ? amount : null,
    baseCredit: side === 'credit' ? amount : null,
  };
}

function normal(accountId: string, side: 'debit' | 'credit', amount: string, base?: string) {
  return {
    accountId,
    description: '',
    kind: 'normal' as const,
    debit: side === 'debit' ? amount : null,
    credit: side === 'credit' ? amount : null,
    baseDebit: side === 'debit' ? (base ?? null) : null,
    baseCredit: side === 'credit' ? (base ?? null) : null,
  };
}

describe('currency reference data', () => {
  it('matches the ISO 4217 list and minor units used by the money engine', async () => {
    const { rows } = await asOwner((db) =>
      db.query<{ code: string; minor_units: number }>(
        'SELECT code, minor_units FROM accounting_currencies WHERE is_active',
      ),
    );
    expect(new Set(rows.map((r) => r.code))).toEqual(new Set(ISO_CURRENCIES));
    for (const row of rows) expect(row.minor_units, row.code).toBe(minorUnits(row.code));
  });

  it('is read-only to the application role', async () => {
    const db = await connectAs('app');
    try {
      await expect(
        db.query(`INSERT INTO accounting_currencies (code, minor_units) VALUES ('ZZZ', 2)`),
      ).rejects.toMatchObject({ code: '42501' });
      const { rows } = await db.query(`SELECT count(*)::int AS n FROM accounting_currencies`);
      expect(rows[0].n).toBeGreaterThan(100);
    } finally {
      await db.end();
    }
  });
});

describe('account currency and classification', () => {
  it('creates template accounts in the base currency, classified and designated', async () => {
    const org = await setUpAccountingOrg(ctx);
    const accounts = (await org.owner.get('/accounting/accounts')).body.data as {
      code: string;
      currencyCode: string;
      subtype: string | null;
      isMonetary: boolean;
      isBankOrCash: boolean;
      isControlAccount: boolean;
    }[];
    const byCode = Object.fromEntries(accounts.map((a) => [a.code, a]));
    expect(accounts.every((a) => a.currencyCode === 'MVR')).toBe(true);
    expect(byCode['1110']).toMatchObject({ subtype: 'CASH', isMonetary: true, isBankOrCash: true });
    expect(byCode['1120']).toMatchObject({ subtype: 'BANK', isMonetary: true, isBankOrCash: true });
    expect(byCode['1130']).toMatchObject({
      subtype: 'ACCOUNTS_RECEIVABLE',
      isMonetary: true,
      isControlAccount: false,
    });
    expect(byCode['2130']).toMatchObject({ subtype: 'OTHER_CURRENT_LIABILITY', isMonetary: false });
    expect(byCode['1000']).toMatchObject({ subtype: null, isMonetary: false });
    for (const code of ['3900', '4950', '4960', '5950']) expect(byCode[code]).toBeDefined();

    const designations = (await org.owner.get('/accounting/designations')).body.data as {
      designation: string;
      accountId: string | null;
    }[];
    expect(Object.fromEntries(designations.map((d) => [d.designation, d.accountId]))).toEqual({
      RETAINED_EARNINGS: org.accounts['3200'],
      REALIZED_FX_GAIN_LOSS: org.accounts['4950'],
      UNREALIZED_FX_GAIN_LOSS: org.accounts['4960'],
      ROUNDING_DIFFERENCE: org.accounts['5950'],
      OPENING_BALANCE_EQUITY: org.accounts['3900'],
    });
  });

  it('leaves accounts unclassified unless a subtype is given, and enforces subtype rules', async () => {
    const org = await setUpAccountingOrg(ctx);
    const plain = await org.owner.post('/accounting/accounts', {
      code: '1190',
      name: 'Sundry',
      type: 'ASSET',
    });
    expect(plain.body.data).toMatchObject({
      currencyCode: 'MVR',
      subtype: null,
      isMonetary: false,
    });

    const wrongNature = await org.owner.post('/accounting/accounts', {
      code: '1191',
      name: 'Bad',
      type: 'EXPENSE',
      subtype: 'BANK',
    });
    expect(wrongNature.status).toBe(400);

    const notMonetary = await org.owner.post('/accounting/accounts', {
      code: '1192',
      name: 'Bad',
      type: 'ASSET',
      subtype: 'FIXED_ASSET',
      isMonetary: true,
    });
    expect(notMonetary.status).toBe(400);

    const bankNotMonetary = await org.owner.post('/accounting/accounts', {
      code: '1193',
      name: 'Bad',
      type: 'ASSET',
      subtype: 'BANK',
      isMonetary: false,
    });
    expect(bankNotMonetary.status).toBe(400);

    const loan = await org.owner.post('/accounting/accounts', {
      code: '2520',
      name: 'USD loan',
      type: 'LIABILITY',
      subtype: 'LONG_TERM_LIABILITY',
      isMonetary: true,
      currencyCode: 'USD',
    });
    expect(loan.body.data).toMatchObject({ currencyCode: 'USD', isMonetary: true });

    const badCurrency = await org.owner.post('/accounting/accounts', {
      code: '1194',
      name: 'Bad',
      type: 'ASSET',
      currencyCode: 'XYZ',
    });
    expect(badCurrency.status).toBe(400);

    // Classifying an existing unclassified account.
    const classified = await org.owner.patch(`/accounting/accounts/${plain.body.data.id}`, {
      subtype: 'OTHER_CURRENT_ASSET',
    });
    expect(classified.body.data).toMatchObject({ subtype: 'OTHER_CURRENT_ASSET' });
    // The type cannot move away from the subtype's nature.
    const typeClash = await org.owner.patch(`/accounting/accounts/${plain.body.data.id}`, {
      type: 'EXPENSE',
    });
    expect(typeClash.status).toBe(400);
  });

  it('enforces the subtype/nature and monetary rules in the database', async () => {
    const org = await setUpAccountingOrg(ctx);
    await asApp(org.organizationId, async (db) => {
      await db.query('SAVEPOINT a');
      await expect(
        db.query(`UPDATE accounting_accounts SET subtype = 'BANK' WHERE id = $1`, [
          org.accounts['5300'],
        ]),
      ).rejects.toMatchObject({ code: '23514' });
      await db.query('ROLLBACK TO SAVEPOINT a');
      await expect(
        db.query(`UPDATE accounting_accounts SET is_monetary = false WHERE id = $1`, [
          org.accounts['1120'],
        ]),
      ).rejects.toMatchObject({ code: '23514' });
    });
  });

  it('makes the account currency immutable once the account has a non-draft line (Decision 70)', async () => {
    const org = await setUpAccountingOrg(ctx);
    const account = await createAccount(org, {
      code: '1125',
      name: 'USD bank',
      type: 'ASSET',
      subtype: 'BANK',
      currencyCode: 'USD',
    });
    // A draft reference does not lock the currency.
    await org.owner.post('/accounting/journals', {
      entryDate: '2026-03-15',
      description: 'draft',
      currency: 'USD',
      exchangeRate: '15.42',
      lines: [line(account.id, 'debit', '10.00'), line(org.accounts['4100']!, 'credit', '10.00')],
    });
    const moved = await org.owner.patch(`/accounting/accounts/${account.id}`, {
      currencyCode: 'EUR',
    });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    const back = await org.owner.patch(`/accounting/accounts/${account.id}`, {
      currencyCode: 'USD',
    });
    expect(back.status).toBe(200);

    await postJournal(org, {
      entryDate: '2026-03-15',
      description: 'USD receipt',
      currency: 'USD',
      exchangeRate: '15.42',
      lines: [line(account.id, 'debit', '10.00'), line(org.accounts['4100']!, 'credit', '10.00')],
    } as never);
    const locked = await org.owner.patch(`/accounting/accounts/${account.id}`, {
      currencyCode: 'EUR',
    });
    expect(locked.status).toBe(409);
    expect(locked.body.error.code).toBe('ACCOUNT_IN_USE');

    // The database refuses as well, even for the migration role.
    await asOwner(async (db) => {
      await expect(
        db.query(`UPDATE accounting_accounts SET currency_code = 'EUR' WHERE id = $1`, [
          account.id,
        ]),
      ).rejects.toMatchObject({ code: '42501' });
    });
  });
});

describe('account-currency posting rule (Decision 11)', () => {
  let org: AccountingOrg;
  let usdBank: string;
  let eurBank: string;

  beforeAll(async () => {
    org = await setUpAccountingOrg(ctx);
    usdBank = (
      await createAccount(org, {
        code: '1126',
        name: 'USD bank',
        type: 'ASSET',
        subtype: 'BANK',
        currencyCode: 'USD',
      })
    ).id;
    eurBank = (
      await createAccount(org, {
        code: '1127',
        name: 'EUR bank',
        type: 'ASSET',
        subtype: 'BANK',
        currencyCode: 'EUR',
      })
    ).id;
  });

  async function tryPost(currency: string, debitAccount: string) {
    const created = await org.owner.post('/accounting/journals', {
      entryDate: '2026-03-15',
      description: 'matrix',
      currency,
      exchangeRate: currency === 'MVR' ? null : '15.00',
      lines: [line(debitAccount, 'debit', '10.00'), line(org.accounts['4100']!, 'credit', '10.00')],
    });
    expect(created.status).toBe(201);
    return org.owner.post(`/accounting/journals/${created.body.data.id}/post`);
  }

  it('accepts accounts in the journal currency or the base currency', async () => {
    expect((await tryPost('USD', usdBank)).status).toBe(200);
    expect((await tryPost('USD', org.accounts['1110']!)).status).toBe(200);
    expect((await tryPost('MVR', org.accounts['1110']!)).status).toBe(200);
  });

  it('rejects a foreign-currency account in any other currency', async () => {
    const base = await tryPost('MVR', usdBank);
    expect(base.status).toBe(400);
    expect(JSON.stringify(base.body)).toContain('USD');
    expect((await tryPost('EUR', usdBank)).status).toBe(400);
    expect((await tryPost('USD', eurBank)).status).toBe(400);
  });

  it('is enforced by the database guard', async () => {
    await asApp(org.organizationId, async (db) => {
      const id = await insertDraft(db, org, 'manual');
      await insertLine(db, org, id, 1, usdBank, 'normal', 'debit', '10.0000', '10.0000');
      await insertLine(
        db,
        org,
        id,
        2,
        org.accounts['4100']!,
        'normal',
        'credit',
        '10.0000',
        '10.0000',
      );
      await expect(
        forgePost(db, org, id, { debit: '10.0000', base: '10.0000' }),
      ).rejects.toMatchObject({
        code: '23514',
        message: expect.stringContaining('another currency'),
      });
    });
  });
});

describe('base-currency change (Decision 26)', () => {
  it('moves base-currency accounts before the first posting and leaves foreign accounts alone', async () => {
    const org = await setUpAccountingOrg(ctx);
    const eur = await createAccount(org, {
      code: '1128',
      name: 'EUR bank',
      type: 'ASSET',
      subtype: 'BANK',
      currencyCode: 'EUR',
    });
    const changed = await org.owner.patch('/accounting/settings', { baseCurrency: 'USD' });
    expect(changed.status).toBe(200);
    const accounts = (await org.owner.get('/accounting/accounts')).body.data as {
      id: string;
      currencyCode: string;
    }[];
    expect(accounts.find((a) => a.id === eur.id)!.currencyCode).toBe('EUR');
    expect(accounts.filter((a) => a.id !== eur.id).every((a) => a.currencyCode === 'USD')).toBe(
      true,
    );

    await postJournal(org, cashSale(org, '5.00', '2026-03-15', 'USD'));
    expect((await org.owner.patch('/accounting/settings', { baseCurrency: 'MVR' })).status).toBe(
      409,
    );
  });

  it('requires pending journals to be withdrawn first', async () => {
    const org = await setUpAccountingOrg(ctx);
    const admin = await joinWithRole(ctx, org.owner, 'Administrator');
    const roles = (await org.owner.get('/organizations/current/roles')).body.data as {
      id: string;
      name: string;
    }[];
    await org.owner.put('/approvals/policies/accounting.journal.post', {
      steps: [
        {
          name: 'Admin',
          requiredApprovals: 1,
          roleIds: [roles.find((r) => r.name === 'Administrator')!.id],
        },
      ],
    });
    const draft = (await org.owner.post('/accounting/journals', cashSale(org))).body.data;
    expect((await org.owner.post(`/accounting/journals/${draft.id}/submit`)).status).toBe(200);
    const blocked = await org.owner.patch('/accounting/settings', { baseCurrency: 'USD' });
    expect(blocked.status).toBe(409);
    expect(admin.userId).toBeTruthy();
  });
});

describe('system account designations (Decisions 14, 64)', () => {
  it('require the right nature and base currency, and every change is audited', async () => {
    const org = await setUpAccountingOrg(ctx);
    const wrongNature = await org.owner.put('/accounting/designations', {
      RETAINED_EARNINGS: org.accounts['4100'],
    });
    expect(wrongNature.status).toBe(400);
    const header = await org.owner.put('/accounting/designations', {
      RETAINED_EARNINGS: org.accounts['3000'],
    });
    expect(header.status).toBe(400);
    const foreign = await createAccount(org, {
      code: '4970',
      name: 'USD FX',
      type: 'REVENUE',
      currencyCode: 'USD',
    });
    expect(
      (await org.owner.put('/accounting/designations', { REALIZED_FX_GAIN_LOSS: foreign.id }))
        .status,
    ).toBe(400);

    const other = await createAccount(org, { code: '3300', name: 'Reserves', type: 'EQUITY' });
    const changed = await org.owner.put('/accounting/designations', {
      RETAINED_EARNINGS: other.id,
      ROUNDING_DIFFERENCE: null,
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    const map = Object.fromEntries(
      (changed.body.data as { designation: string; accountId: string | null }[]).map((d) => [
        d.designation,
        d.accountId,
      ]),
    );
    expect(map).toMatchObject({ RETAINED_EARNINGS: other.id, ROUNDING_DIFFERENCE: null });

    const audit = (await org.owner.get('/organizations/current/audit-events?limit=5')).body.data;
    const entry = audit.find(
      (e: { action: string }) => e.action === 'accounting.designations_changed',
    );
    expect(entry.metadata.changes).toEqual(
      expect.arrayContaining([
        { designation: 'RETAINED_EARNINGS', from: org.accounts['3200'], to: other.id },
        { designation: 'ROUNDING_DIFFERENCE', from: org.accounts['5950'], to: null },
      ]),
    );

    // A designated account cannot be archived, deleted, re-typed or become a parent.
    expect((await org.owner.post(`/accounting/accounts/${other.id}/archive`)).status).toBe(409);
    expect((await org.owner.delete(`/accounting/accounts/${other.id}`)).status).toBe(409);
    expect(
      (
        await org.owner.post('/accounting/accounts', {
          code: '3310',
          name: 'Child',
          type: 'EQUITY',
          parentId: other.id,
        })
      ).status,
    ).toBe(409);
  });

  it('need accounting.setup to change', async () => {
    const org = await setUpAccountingOrg(ctx);
    const member = await joinWithRole(ctx, org.owner, 'Member');
    expect((await member.client.get('/accounting/designations')).status).toBe(200);
    expect(
      (await member.client.put('/accounting/designations', { RETAINED_EARNINGS: null })).status,
    ).toBe(403);
  });

  it('start empty for organizations on the custom template (no guessing)', async () => {
    const org = await setUpAccountingOrg(ctx, { templateKey: 'custom' });
    const list = (await org.owner.get('/accounting/designations')).body.data as {
      accountId: string | null;
    }[];
    expect(list).toHaveLength(5);
    expect(list.every((d) => d.accountId === null)).toBe(true);
  });
});

describe('FX line model and posting guard (Decision 10)', () => {
  let org: AccountingOrg;
  let usdBank: string;
  let usdPrepaid: string;

  beforeAll(async () => {
    org = await setUpAccountingOrg(ctx);
    usdBank = (
      await createAccount(org, {
        code: '1129',
        name: 'USD bank',
        type: 'ASSET',
        subtype: 'BANK',
        currencyCode: 'USD',
      })
    ).id;
    usdPrepaid = (
      await createAccount(org, {
        code: '1155',
        name: 'USD prepaid',
        type: 'ASSET',
        subtype: 'OTHER_CURRENT_ASSET',
        currencyCode: 'USD',
      })
    ).id;
  });

  it('posts a revaluation of base-only lines to a foreign monetary account (Decision 71)', async () => {
    const posted = await systemJournal(org, {
      lines: [
        baseOnly(usdBank, 'debit', '12.35'),
        baseOnly(org.accounts['4960']!, 'credit', '12.35'),
      ],
    });
    expect(posted).toMatchObject({
      status: 'POSTED',
      source: 'system',
      sourceType: 'revaluation',
      totalDebit: '0.0000',
      totalBaseDebit: '12.3500',
    });
    const view = (await org.owner.get(`/accounting/journals/${posted.id}`)).body.data;
    expect(view.lines.map((l: { kind: string }) => l.kind)).toEqual(['base_only', 'base_only']);
    expect(view.lines[0]).toMatchObject({ debit: null, baseDebit: '12.3500' });
  });

  it('posts a realized-FX journal mixing normal lines at explicit base amounts and a base-only line', async () => {
    const posted = await systemJournal(org, {
      source: { module: 'sales', type: 'realized_fx', id: randomUUID() },
      currency: 'USD',
      exchangeRate: '15.50',
      lines: [
        normal(usdBank, 'debit', '100.00', '1550.00'),
        normal(org.accounts['1130']!, 'credit', '100.00', '1542.00'),
        baseOnly(org.accounts['4950']!, 'credit', '8.00'),
      ],
    });
    expect(posted).toMatchObject({ totalDebit: '100.0000', totalBaseDebit: '1550.0000' });
  });

  it('rejects base-only lines on foreign non-monetary accounts, disallowed types, or unbalanced base', async () => {
    await expect(
      systemJournal(org, {
        lines: [
          baseOnly(usdPrepaid, 'debit', '1.00'),
          baseOnly(org.accounts['4960']!, 'credit', '1.00'),
        ],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      systemJournal(org, {
        source: { module: 'accounting', type: 'opening_balance', id: randomUUID() },
        lines: [
          baseOnly(usdBank, 'debit', '1.00'),
          baseOnly(org.accounts['4960']!, 'credit', '1.00'),
        ],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      systemJournal(org, {
        source: { module: 'accounting', type: 'made_up', id: randomUUID() },
        lines: [
          normal(org.accounts['1110']!, 'debit', '1.00'),
          normal(org.accounts['4100']!, 'credit', '1.00'),
        ],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      systemJournal(org, {
        lines: [
          baseOnly(usdBank, 'debit', '2.00'),
          baseOnly(org.accounts['4960']!, 'credit', '1.00'),
        ],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('converts normal system lines at the journal rate when no base amounts are given', async () => {
    const posted = await systemJournal(org, {
      source: { module: 'accounting', type: 'opening_balance', id: randomUUID() },
      currency: 'USD',
      exchangeRate: '15.42',
      lines: [normal(usdBank, 'debit', '10.00'), normal(org.accounts['3900']!, 'credit', '10.00')],
    });
    expect(posted).toMatchObject({ totalBaseDebit: '154.2000', exchangeRate: '15.4200000000' });
  });

  it('keeps manual journals free of base-only lines, even through forged SQL', async () => {
    await asApp(org.organizationId, async (db) => {
      const id = await insertDraft(db, org, 'manual');
      await insertLine(
        db,
        org,
        id,
        1,
        org.accounts['1110']!,
        'normal',
        'debit',
        '100.0000',
        '100.0000',
      );
      await insertLine(
        db,
        org,
        id,
        2,
        org.accounts['4100']!,
        'normal',
        'credit',
        '100.0000',
        '100.0000',
      );
      await insertLine(db, org, id, 3, org.accounts['1110']!, 'base_only', 'debit', null, '5.0000');
      await insertLine(
        db,
        org,
        id,
        4,
        org.accounts['4960']!,
        'base_only',
        'credit',
        null,
        '5.0000',
      );
      await expect(
        forgePost(db, org, id, { debit: '100.0000', base: '105.0000' }),
      ).rejects.toMatchObject({
        code: '23514',
        message: expect.stringContaining('base-only'),
      });
    });
    // The manual API has no line kinds or base amounts at all.
    const created = await org.owner.post('/accounting/journals', {
      ...cashSale(org),
      lines: [
        { ...line(org.accounts['1110']!, 'debit', '1.00'), kind: 'base_only', baseDebit: '1.00' },
        line(org.accounts['4100']!, 'credit', '1.00'),
      ],
    });
    expect(created.status).toBe(400);
  });

  it('checks base balance on all lines and transaction balance on normal lines in the database', async () => {
    await asApp(org.organizationId, async (db) => {
      await db.query('SAVEPOINT a');
      const unbalancedBase = await insertDraft(db, org, 'system', 'revaluation');
      await insertLine(db, org, unbalancedBase, 1, usdBank, 'base_only', 'debit', null, '5.0000');
      await insertLine(
        db,
        org,
        unbalancedBase,
        2,
        org.accounts['4960']!,
        'base_only',
        'credit',
        null,
        '4.0000',
      );
      await expect(
        forgePost(db, org, unbalancedBase, { debit: '0', base: '5.0000' }),
      ).rejects.toMatchObject({
        code: '23514',
      });
      await db.query('ROLLBACK TO SAVEPOINT a');

      const unbalancedTxn = await insertDraft(db, org, 'system', 'realized_fx');
      await insertLine(
        db,
        org,
        unbalancedTxn,
        1,
        org.accounts['1110']!,
        'normal',
        'debit',
        '10.0000',
        '10.0000',
      );
      await insertLine(
        db,
        org,
        unbalancedTxn,
        2,
        org.accounts['4100']!,
        'normal',
        'credit',
        '9.0000',
        '9.0000',
      );
      await insertLine(
        db,
        org,
        unbalancedTxn,
        3,
        org.accounts['4950']!,
        'base_only',
        'credit',
        null,
        '1.0000',
      );
      await expect(
        forgePost(db, org, unbalancedTxn, { debit: '10.0000', base: '10.0000' }),
      ).rejects.toMatchObject({
        code: '23514',
      });
      await db.query('ROLLBACK TO SAVEPOINT a');

      const valid = await insertDraft(db, org, 'system', 'revaluation');
      await insertLine(db, org, valid, 1, usdBank, 'base_only', 'debit', null, '5.0000');
      await insertLine(
        db,
        org,
        valid,
        2,
        org.accounts['4960']!,
        'base_only',
        'credit',
        null,
        '5.0000',
      );
      await forgePost(db, org, valid, { debit: '0', base: '5.0000' });
    });
  });

  it('refuses manual reversal of FX/revaluation journals', async () => {
    const posted = await systemJournal(org, {
      lines: [
        baseOnly(usdBank, 'debit', '3.00'),
        baseOnly(org.accounts['4960']!, 'credit', '3.00'),
      ],
    });
    const reversal = await org.owner.post(`/accounting/journals/${posted.id}/reverse`, {
      reason: 'try to reverse',
    });
    expect(reversal.status).toBe(409);
    expect(reversal.body.error.code).toBe('SYSTEM_JOURNAL');
  });
});

describe('source references (Decision 12)', () => {
  it('are set at creation and immutable', async () => {
    const org = await setUpAccountingOrg(ctx);
    const sourceId = randomUUID();
    const posted = await systemJournal(org, {
      source: { module: 'accounting', type: 'opening_balance', id: sourceId },
      lines: [
        normal(org.accounts['1110']!, 'debit', '1.00'),
        normal(org.accounts['3900']!, 'credit', '1.00'),
      ],
    });
    expect(posted).toMatchObject({ sourceModule: 'accounting', sourceId });
    await asApp(org.organizationId, async (db) => {
      await db.query('SAVEPOINT a');
      await expect(
        db.query(`UPDATE accounting_journal_entries SET source_id = $2 WHERE id = $1`, [
          posted.id,
          randomUUID(),
        ]),
      ).rejects.toMatchObject({ code: '42501' });
      await db.query('ROLLBACK TO SAVEPOINT a');
      const draft = await insertDraft(db, org, 'system', 'revaluation');
      await expect(
        db.query(
          `UPDATE accounting_journal_entries SET source_type = 'realized_fx' WHERE id = $1`,
          [draft],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });
    // Legacy manual journals keep NULL sources.
    const manual = await postJournal(org);
    expect(manual).toMatchObject({ source: 'manual', sourceModule: null, sourceId: null });
  });
});

describe('control accounts (C3)', () => {
  it('are rejected in manual journals, by the service and by the database', async () => {
    const org = await setUpAccountingOrg(ctx);
    await markControl(org, '1130');
    const draft = await org.owner.post('/accounting/journals', {
      ...cashSale(org),
      lines: [
        line(org.accounts['1130']!, 'debit', '1.00'),
        line(org.accounts['4100']!, 'credit', '1.00'),
      ],
    });
    expect(draft.status).toBe(400);
    expect(JSON.stringify(draft.body)).toContain('Control accounts');

    await asApp(org.organizationId, async (db) => {
      const id = await insertDraft(db, org, 'manual');
      await insertLine(
        db,
        org,
        id,
        1,
        org.accounts['1130']!,
        'normal',
        'debit',
        '1.0000',
        '1.0000',
      );
      await insertLine(
        db,
        org,
        id,
        2,
        org.accounts['4100']!,
        'normal',
        'credit',
        '1.0000',
        '1.0000',
      );
      await expect(
        forgePost(db, org, id, { debit: '1.0000', base: '1.0000' }),
      ).rejects.toMatchObject({
        code: '23514',
        message: expect.stringContaining('control account'),
      });
    });
  });
});

describe('transaction-aware event intake (C1)', () => {
  function register(org: AccountingOrg, eventType: string, domainApproval = false) {
    ctx.services.journals.registerEventHandler(
      eventType,
      ({ payload }) => ({
        entryDate: '2026-05-10',
        description: `Invoice ${String(payload.id)}`,
        reference: String(payload.id),
        currency: 'MVR',
        exchangeRate: null,
        sourceRef: { module: 'test-sales', type: 'invoice', id: String(payload.id) },
        lines: [
          line(org.accounts['1130']!, 'debit', '25.00'),
          line(org.accounts['4100']!, 'credit', '25.00'),
        ],
      }),
      { domainApproval },
    );
  }

  it('commits the event and its journal with the caller, and rolls both back on failure', async () => {
    const org = await setUpAccountingOrg(ctx);
    await markControl(org, '1130');
    const eventType = `test_c1_${randomInt(1e9)}.issued`;
    register(org, eventType);
    const invoiceId = randomUUID();
    const event = {
      organizationId: org.organizationId,
      sourceModule: 'test-sales',
      eventType,
      eventKey: `inv-${invoiceId}`,
      payload: { id: invoiceId },
      occurredAt: new Date(),
      origin,
    };

    await expect(
      inTransaction(ctx.database.db, { organizationId: org.organizationId }, async (tx) => {
        await setDbContext(tx, { organizationId: org.organizationId });
        const result = await ctx.services.journals.receiveEventInTransaction(tx, event);
        expect(result.outcome).toBe('processed');
        throw new Error('the sales document failed to save');
      }),
    ).rejects.toThrow('the sales document failed to save');
    expect((await org.owner.get('/accounting/journals')).body.data).toHaveLength(0);
    const { rows } = await asOwner((db) =>
      db.query(`SELECT count(*)::int AS n FROM accounting_events WHERE organization_id = $1`, [
        org.organizationId,
      ]),
    );
    expect(rows[0].n).toBe(0);

    const committed = await inTransaction(
      ctx.database.db,
      { organizationId: org.organizationId },
      async (tx) => {
        await setDbContext(tx, { organizationId: org.organizationId });
        return ctx.services.journals.receiveEventInTransaction(tx, event);
      },
    );
    expect(committed.outcome).toBe('processed');
    const journal = (await org.owner.get(`/accounting/journals/${committed.journalId}`)).body.data;
    // Event journals may use control accounts; they carry their source reference.
    expect(journal).toMatchObject({
      status: 'POSTED',
      source: 'event',
      sourceModule: 'test-sales',
      sourceType: 'invoice',
      sourceId: invoiceId,
    });
  });

  it('throws handler failures to the caller instead of recording them', async () => {
    const org = await setUpAccountingOrg(ctx);
    const eventType = `test_c1_bad_${randomInt(1e9)}.issued`;
    ctx.services.journals.registerEventHandler(eventType, () => ({
      entryDate: '2026-05-10',
      description: 'unbalanced',
      reference: '',
      currency: 'MVR',
      exchangeRate: null,
      lines: [
        line(org.accounts['1130']!, 'debit', '1.00'),
        line(org.accounts['4100']!, 'credit', '2.00'),
      ],
    }));
    await expect(
      inTransaction(ctx.database.db, { organizationId: org.organizationId }, async (tx) => {
        await setDbContext(tx, { organizationId: org.organizationId });
        return ctx.services.journals.receiveEventInTransaction(tx, {
          organizationId: org.organizationId,
          sourceModule: 'test-sales',
          eventType,
          eventKey: randomUUID(),
          payload: {},
          occurredAt: new Date(),
          origin,
        });
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('posts domain-approved event journals directly even when journal approval is configured (Decision 13)', async () => {
    const org = await setUpAccountingOrg(ctx);
    const roles = (await org.owner.get('/organizations/current/roles')).body.data as {
      id: string;
      name: string;
    }[];
    await org.owner.put('/approvals/policies/accounting.journal.post', {
      steps: [
        {
          name: 'Admin',
          requiredApprovals: 1,
          roleIds: [roles.find((r) => r.name === 'Administrator')!.id],
        },
      ],
    });
    const domain = `test_c1_domain_${randomInt(1e9)}.issued`;
    const plain = `test_c1_plain_${randomInt(1e9)}.issued`;
    register(org, domain, true);
    register(org, plain, false);
    const run = (eventType: string) =>
      inTransaction(ctx.database.db, { organizationId: org.organizationId }, async (tx) => {
        await setDbContext(tx, { organizationId: org.organizationId });
        return ctx.services.journals.receiveEventInTransaction(tx, {
          organizationId: org.organizationId,
          sourceModule: 'test-sales',
          eventType,
          eventKey: randomUUID(),
          payload: { id: randomUUID() },
          occurredAt: new Date(),
          origin,
        });
      });
    const direct = await run(domain);
    const waiting = await run(plain);
    expect((await org.owner.get(`/accounting/journals/${direct.journalId}`)).body.data.status).toBe(
      'POSTED',
    );
    expect(
      (await org.owner.get(`/accounting/journals/${waiting.journalId}`)).body.data.status,
    ).toBe('DRAFT');
  });
});

describe('tenant isolation of Phase 3A accounting tables', () => {
  it('hides other organizations designations and rejects cross-tenant designation writes', async () => {
    const a = await setUpAccountingOrg(ctx);
    const b = await setUpAccountingOrg(ctx);
    await asApp(a.organizationId, async (db) => {
      const { rows } = await db.query(
        `SELECT count(*)::int AS n FROM accounting_designations WHERE organization_id = $1`,
        [b.organizationId],
      );
      expect(rows[0].n).toBe(0);
      await expect(
        db.query(`UPDATE accounting_designations SET account_id = $1 WHERE organization_id = $2`, [
          a.accounts['3100'],
          b.organizationId,
        ]),
      ).resolves.toMatchObject({ rowCount: 0 });
    });
    // Designating another organization's account through the API fails.
    const cross = await a.owner.put('/accounting/designations', {
      RETAINED_EARNINGS: b.accounts['3200'],
    });
    expect(cross.status).toBe(400);
  });
});
