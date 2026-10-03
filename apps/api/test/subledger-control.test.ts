import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthorizationContext } from '../src/application/authorization.js';
import { inTransaction } from '../src/application/unit-of-work.js';
import { readMigrationFiles } from '../src/database/migrator.js';
import type { Subledger } from '../src/modules/accounting/index.js';
import { line, setUpAccountingOrg, type AccountingOrg } from './fixtures.js';
import { connectAs, createTestContext, type TestContext } from './helpers.js';

/**
 * Phase 4A-1 (ADR 0004 P4-07, P4-08): which subledger owns a control account. Serial: the backfill
 * replay drops the consistency CHECK inside a rolled-back transaction.
 */

let ctx: TestContext;
let owner: pg.Client;
beforeAll(async () => {
  ctx = await createTestContext();
  owner = await connectAs('owner');
});
afterAll(async () => {
  await owner.end();
  await ctx.close();
});

const origin = { requestId: 'subledger-control-test', ipAddress: null, userAgent: 'vitest' };

async function actingContext(org: AccountingOrg): Promise<AuthorizationContext> {
  const principal = await ctx.services.auth.authenticate(org.owner.sessionToken!, origin);
  return {
    userId: principal!.user.id,
    sessionId: principal!.session.id,
    organizationId: org.organizationId,
    membershipId: 'test',
    isOwner: true,
    roleIds: [],
    permissions: new Set(),
  };
}

/** Calls the generalized marking operation the way a settings service does, in one transaction. */
async function mark(
  org: AccountingOrg,
  input: { subledger: Subledger; accountId: string | null; previousAccountId: string | null },
) {
  const actx = await actingContext(org);
  return inTransaction(
    ctx.database.db,
    { userId: actx.userId, organizationId: org.organizationId },
    (tx) =>
      ctx.services.accounting.setSubledgerControlInTransaction(
        tx,
        actx,
        { ...input, path: 'accountId' },
        origin,
      ),
  );
}

async function row(accountId: string) {
  const { rows } = await owner.query(
    `SELECT is_control_account, control_subledger FROM accounting_accounts WHERE id = $1`,
    [accountId],
  );
  return rows[0] as { is_control_account: boolean; control_subledger: string | null };
}

async function createAccount(
  org: AccountingOrg,
  input: { code: string; type: string; subtype: string; currencyCode?: string },
) {
  const created = await org.owner.post('/accounting/accounts', {
    code: input.code,
    name: `Test ${input.code}`,
    type: input.type,
    subtype: input.subtype,
    ...(input.currencyCode ? { currencyCode: input.currencyCode } : {}),
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.data.id as string;
}

const salesSettings = (arAccountId: string | null, version = 0) => ({
  version,
  arAccountId,
  defaultRevenueAccountId: null,
  defaultDepositAccountId: null,
  defaultTaxCodeId: null,
  defaultTaxTreatment: 'exclusive',
  defaultPaymentTermsDays: 30,
});

describe('subledger control ownership (P4-08)', () => {
  it('records the Sales AR control account as owned by sales (Phase 3B E3 unchanged)', async () => {
    const org = await setUpAccountingOrg(ctx);
    const saved = await org.owner.put('/sales/settings', salesSettings(org.accounts['1130']!));
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(await row(org.accounts['1130']!)).toEqual({
      is_control_account: true,
      control_subledger: 'sales',
    });
    const accounts = (await org.owner.get('/accounting/accounts')).body.data as {
      id: string;
      controlSubledger: string | null;
    }[];
    expect(accounts.find((a) => a.id === org.accounts['1130'])!.controlSubledger).toBe('sales');
    expect(accounts.find((a) => a.id === org.accounts['2110'])!.controlSubledger).toBeNull();
    // Choosing no AR account releases it again.
    const cleared = await org.owner.put('/sales/settings', salesSettings(null, 1));
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    expect(await row(org.accounts['1130']!)).toEqual({
      is_control_account: false,
      control_subledger: null,
    });
  });

  it('marks the AP account for purchases, audits it, and closes it to manual journals (C3)', async () => {
    const org = await setUpAccountingOrg(ctx);
    const ap = org.accounts['2110']!;
    await mark(org, { subledger: 'purchases', accountId: ap, previousAccountId: null });
    expect(await row(ap)).toEqual({ is_control_account: true, control_subledger: 'purchases' });
    const audit = await owner.query(
      `SELECT action, metadata FROM audit_events WHERE organization_id = $1 AND resource_id = $2`,
      [org.organizationId, ap],
    );
    expect(audit.rows).toEqual([
      {
        action: 'account.control_marked',
        metadata: { subledger: 'purchases', role: 'accounts_payable' },
      },
    ]);
    const journal = await org.owner.post('/accounting/journals', {
      entryDate: '2026-03-01',
      description: 'Manual to AP',
      reference: 'AP-1',
      currency: 'MVR',
      exchangeRate: null,
      lines: [line(org.accounts['5300']!, 'debit', '10.00'), line(ap, 'credit', '10.00')],
    });
    expect(journal.status).toBe(400);
    expect(JSON.stringify(journal.body)).toContain(
      'Control accounts cannot be used in manual journals',
    );
    // Marking it again is a no-op (no second audit event).
    await mark(org, { subledger: 'purchases', accountId: ap, previousAccountId: ap });
    const again = await owner.query(
      `SELECT count(*)::int AS n FROM audit_events WHERE organization_id = $1 AND resource_id = $2`,
      [org.organizationId, ap],
    );
    expect(again.rows[0].n).toBe(1);
  });

  it('enforces the AP control-account rules without inferring anything', async () => {
    const org = await setUpAccountingOrg(ctx);
    const refused = async (subledger: Subledger, accountId: string, message: string) => {
      await expect(
        mark(org, { subledger, accountId, previousAccountId: null }),
      ).rejects.toMatchObject({
        details: { issues: [{ path: 'accountId', message }] },
      });
    };
    await refused(
      'purchases',
      org.accounts['1130']!,
      'Choose a liability account classified as Accounts Payable.',
    );
    await refused(
      'sales',
      org.accounts['2110']!,
      'Choose an asset account classified as Accounts Receivable.',
    );
    // An unclassified liability is never treated as AP.
    await refused(
      'purchases',
      org.accounts['2120']!,
      'Choose a liability account classified as Accounts Payable.',
    );
    const usd = await createAccount(org, {
      code: '2111',
      type: 'LIABILITY',
      subtype: 'ACCOUNTS_PAYABLE',
      currencyCode: 'USD',
    });
    await refused('purchases', usd, 'The AP control account is in the base currency.');
    const parent = await createAccount(org, {
      code: '2112',
      type: 'LIABILITY',
      subtype: 'ACCOUNTS_PAYABLE',
    });
    const child = await org.owner.post('/accounting/accounts', {
      code: '2113',
      name: 'Child',
      type: 'LIABILITY',
      subtype: 'ACCOUNTS_PAYABLE',
      parentId: parent,
    });
    expect(child.status, JSON.stringify(child.body)).toBe(201);
    await refused('purchases', parent, 'The AP account must be a posting (leaf) account.');
    // Posted entries from outside Purchases (here a manual journal) disqualify the account.
    const used = await createAccount(org, {
      code: '2114',
      type: 'LIABILITY',
      subtype: 'ACCOUNTS_PAYABLE',
    });
    const journal = await org.owner.post('/accounting/journals', {
      entryDate: '2026-03-01',
      description: 'Supplier balance',
      reference: 'X',
      currency: 'MVR',
      exchangeRate: null,
      lines: [line(org.accounts['5300']!, 'debit', '25.00'), line(used, 'credit', '25.00')],
    });
    expect(journal.status, JSON.stringify(journal.body)).toBe(201);
    const posted = await org.owner.post(`/accounting/journals/${journal.body.data.id}/post`);
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    await refused(
      'purchases',
      used,
      'This account already has posted entries from outside Purchases, so it cannot become the AP control account.',
    );
    // An account another subledger controls cannot be taken over.
    const owned = await createAccount(org, {
      code: '2115',
      type: 'LIABILITY',
      subtype: 'ACCOUNTS_PAYABLE',
    });
    await owner.query(
      `UPDATE accounting_accounts SET is_control_account = true, control_subledger = 'sales' WHERE id = $1`,
      [owned],
    );
    await refused(
      'purchases',
      owned,
      'This account is already the control account of another subledger.',
    );
  });

  it('releases only its own previous control account when switching', async () => {
    const org = await setUpAccountingOrg(ctx);
    const first = org.accounts['2110']!;
    const second = await createAccount(org, {
      code: '2116',
      type: 'LIABILITY',
      subtype: 'ACCOUNTS_PAYABLE',
    });
    await mark(org, { subledger: 'purchases', accountId: first, previousAccountId: null });
    await mark(org, { subledger: 'purchases', accountId: second, previousAccountId: first });
    expect(await row(first)).toEqual({ is_control_account: false, control_subledger: null });
    expect(await row(second)).toEqual({ is_control_account: true, control_subledger: 'purchases' });
    const released = await owner.query(
      `SELECT metadata FROM audit_events WHERE organization_id = $1 AND resource_id = $2
          AND action = 'account.control_released'`,
      [org.organizationId, first],
    );
    expect(released.rows).toEqual([
      { metadata: { subledger: 'purchases', role: 'accounts_payable' } },
    ]);
    // A "previous" account owned by another subledger is never released by this one.
    const saved = await org.owner.put('/sales/settings', salesSettings(org.accounts['1130']!));
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    await mark(org, {
      subledger: 'purchases',
      accountId: null,
      previousAccountId: org.accounts['1130']!,
    });
    expect(await row(org.accounts['1130']!)).toEqual({
      is_control_account: true,
      control_subledger: 'sales',
    });
    // Releasing with no new account leaves Purchases without a control account.
    await mark(org, { subledger: 'purchases', accountId: null, previousAccountId: second });
    expect(await row(second)).toEqual({ is_control_account: false, control_subledger: null });
  });

  it('is guarded by the database: the flag and its owner always agree', async () => {
    const org = await setUpAccountingOrg(ctx);
    const id = org.accounts['2110']!;
    const attempt = (set: string) =>
      owner.query(`UPDATE accounting_accounts SET ${set} WHERE id = $1`, [id]).then(
        () => null,
        (error: { code?: string }) => error.code,
      );
    expect(await attempt('is_control_account = true')).toBe('23514');
    expect(await attempt(`control_subledger = 'purchases'`)).toBe('23514');
    expect(await attempt(`is_control_account = true, control_subledger = 'banking'`)).toBe('23514');
    expect(await row(id)).toEqual({ is_control_account: false, control_subledger: null });
  });

  it('backfills existing control accounts to sales with an audit event (migration 0027)', async () => {
    const sql = readMigrationFiles().find(
      (m) => m.version === '0027_subledger_control_ownership',
    )!.sql;
    const backfill = sql.slice(sql.indexOf('-- backfill:begin'), sql.indexOf('-- backfill:end'));
    const org = await setUpAccountingOrg(ctx);
    const saved = await org.owner.put('/sales/settings', salesSettings(org.accounts['1130']!));
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    await owner.query('BEGIN');
    try {
      // Simulate the account as it was before 0027: a control account with no recorded owner.
      await owner.query(
        `ALTER TABLE accounting_accounts DROP CONSTRAINT accounting_accounts_control_subledger_consistency`,
      );
      await owner.query(`UPDATE accounting_accounts SET control_subledger = NULL WHERE id = $1`, [
        org.accounts['1130'],
      ]);
      await owner.query(
        `CREATE TEMPORARY TABLE p4_control_backfilled (account_id uuid, organization_id uuid) ON COMMIT DROP`,
      );
      await owner.query(backfill);
      expect(await row(org.accounts['1130']!)).toEqual({
        is_control_account: true,
        control_subledger: 'sales',
      });
      const { rows } = await owner.query(
        `SELECT actor_type, metadata->>'subledger' AS subledger FROM audit_events
          WHERE organization_id = $1 AND resource_id = $2
            AND request_id = 'migration:0027_subledger_control_ownership'`,
        [org.organizationId, org.accounts['1130']],
      );
      expect(rows).toEqual([{ actor_type: 'system', subledger: 'sales' }]);
    } finally {
      await owner.query('ROLLBACK');
    }
  });
});

describe('control-account integrity (ADR 0004, P4-08 amendment)', () => {
  const locked = (label: string, module: string, action: string) =>
    `This account is the ${label} control account of ${module}. Release it in ${module} settings before ${action}.`;

  async function ownedOrg() {
    const org = await setUpAccountingOrg(ctx);
    const saved = await org.owner.put('/sales/settings', salesSettings(org.accounts['1130']!));
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    await mark(org, {
      subledger: 'purchases',
      accountId: org.accounts['2110']!,
      previousAccountId: null,
    });
    return org;
  }

  const cases = [
    {
      name: 'AR (Sales)',
      code: '1130',
      type: 'ASSET',
      label: 'AR',
      module: 'Sales',
      otherSubtype: 'OTHER_CURRENT_ASSET',
      otherType: 'EXPENSE',
      otherTypeSubtype: 'OPERATING_EXPENSE',
      sibling: '1150',
    },
    {
      name: 'AP (Purchases)',
      code: '2110',
      type: 'LIABILITY',
      label: 'AP',
      module: 'Purchases',
      otherSubtype: 'OTHER_CURRENT_LIABILITY',
      otherType: 'EQUITY',
      otherTypeSubtype: 'EQUITY',
      sibling: '2120',
    },
  ];

  for (const c of cases) {
    it(`refuses every guarded change to the ${c.name} control account, and allows the rest`, async () => {
      const org = await ownedOrg();
      const id = org.accounts[c.code]!;
      const before = await owner.query(
        `SELECT account_type, subtype, currency_code, parent_id, status FROM accounting_accounts WHERE id = $1`,
        [id],
      );
      const refused = async (body: Record<string, unknown>) => {
        const res = await org.owner.patch(`/accounting/accounts/${id}`, body);
        expect(res.status, JSON.stringify(body)).toBe(409);
        expect(res.body.error).toMatchObject({
          code: 'ACCOUNT_IN_USE',
          message: locked(c.label, c.module, 'changing its type, subtype, currency or parent'),
        });
      };
      await refused({ subtype: c.otherSubtype });
      await refused({ subtype: null });
      await refused({ type: c.otherType, subtype: c.otherTypeSubtype, parentId: null });
      await refused({ currencyCode: 'USD' });
      await refused({ parentId: null });

      const archived = await org.owner.post(`/accounting/accounts/${id}/archive`, {});
      expect(archived.status, JSON.stringify(archived.body)).toBe(409);
      expect(archived.body.error).toMatchObject({
        code: 'ACCOUNT_IN_USE',
        message: locked(c.label, c.module, 'archiving it'),
      });

      // It cannot gain a child account, by creation or by moving another account under it.
      const child = await org.owner.post('/accounting/accounts', {
        code: `${c.code}9`,
        name: 'Child',
        type: c.type,
        parentId: id,
      });
      expect(child.status, JSON.stringify(child.body)).toBe(409);
      expect(child.body.error.message).toBe(
        'A subledger control account receives postings, so it cannot become a parent.',
      );
      const moved = await org.owner.patch(`/accounting/accounts/${org.accounts[c.sibling]}`, {
        parentId: id,
      });
      expect(moved.status, JSON.stringify(moved.body)).toBe(409);
      expect(moved.body.error.message).toBe(
        'A subledger control account receives postings, so it cannot become a parent.',
      );

      // Name and description are not restricted.
      const renamed = await org.owner.patch(`/accounting/accounts/${id}`, {
        name: `Trade ${c.label}`,
        description: 'Renamed while owned',
      });
      expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);

      const after = await owner.query(
        `SELECT account_type, subtype, currency_code, parent_id, status FROM accounting_accounts WHERE id = $1`,
        [id],
      );
      expect(after.rows[0]).toEqual(before.rows[0]);
      expect(await row(id)).toMatchObject({ is_control_account: true });
    });
  }

  it('refuses a base-currency change while a control account is owned (Decision 26 path)', async () => {
    const org = await ownedOrg();
    const res = await org.owner.patch('/accounting/settings', { baseCurrency: 'USD' });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('ACCOUNT_IN_USE');
    expect(res.body.error.message).toMatch(
      /^This account is the A[RP] control account of (Sales|Purchases)\. Release it in (Sales|Purchases) settings before changing the base currency\.$/,
    );
    const { rows } = await owner.query(
      `SELECT base_currency FROM accounting_settings WHERE organization_id = $1`,
      [org.organizationId],
    );
    expect(rows[0].base_currency).toBe('MVR');
  });

  it('refuses a chart-of-accounts import that puts an account under a control account', async () => {
    const org = await ownedOrg();
    const created = await org.owner.post('/imports', { domain: 'chart_of_accounts', options: {} });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.data.id as string;
    const up = await org.owner.upload(
      `/files?linkType=import_batch&linkId=${id}`,
      Buffer.from('Account Code,Account Name,Type,Parent\r\nY2119,Sub payables,Liability,2110\r\n'),
      'coa.csv',
    );
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    const inspected = await org.owner.post(`/imports/${id}/inspect`, {});
    expect(inspected.status, JSON.stringify(inspected.body)).toBe(200);
    const mapped = await org.owner.put(`/imports/${id}/mapping`, {
      version: inspected.body.data.batch.version,
      mapping: inspected.body.data.suggestedMapping,
    });
    expect(mapped.status, JSON.stringify(mapped.body)).toBe(202);
    for (let i = 0; i < 40; i++) {
      const res = await org.owner.get(`/imports/${id}`);
      if (res.body.data.status !== 'validating') break;
      await ctx.worker.runOnce();
    }
    const errors = await org.owner.get(`/imports/${id}/rows?status=error&limit=10`);
    expect(errors.status, JSON.stringify(errors.body)).toBe(200);
    expect(JSON.stringify(errors.body.data.rows)).toContain(
      'A subledger control account cannot become a parent.',
    );
  });

  it('is backstopped in the database for every guarded column', async () => {
    const org = await ownedOrg();
    for (const id of [org.accounts['1130']!, org.accounts['2110']!]) {
      for (const set of [
        `subtype = NULL`,
        `account_type = 'EXPENSE', subtype = NULL, parent_id = NULL`,
        `currency_code = 'USD'`,
        `parent_id = NULL`,
        `status = 'ARCHIVED', archived_at = now()`,
      ]) {
        const outcome = await owner
          .query(`UPDATE accounting_accounts SET ${set} WHERE id = $1`, [id])
          .then(
            () => 'allowed',
            (error: { code?: string; message: string }) => `${error.code}: ${error.message}`,
          );
        expect(outcome, set).toMatch(
          /^23514: account .* is the control account of the (sales|purchases) subledger/,
        );
      }
    }
    // No child under an owned control account, also at the database level.
    const child = await owner
      .query(`UPDATE accounting_accounts SET parent_id = $1 WHERE id = $2`, [
        org.accounts['2110'],
        org.accounts['2120'],
      ])
      .then(
        () => 'allowed',
        (error: { code?: string; message: string }) => `${error.code}: ${error.message}`,
      );
    expect(child).toMatch(
      /^23514: account .* is a subledger control account and cannot have child accounts/,
    );
  });

  it('lets a released control account be changed normally', async () => {
    const org = await ownedOrg();
    const cleared = await org.owner.put('/sales/settings', salesSettings(null, 1));
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    await mark(org, {
      subledger: 'purchases',
      accountId: null,
      previousAccountId: org.accounts['2110']!,
    });
    for (const c of cases) {
      const id = org.accounts[c.code]!;
      expect(await row(id)).toEqual({ is_control_account: false, control_subledger: null });
      const child = await org.owner.post('/accounting/accounts', {
        code: `${c.code}8`,
        name: 'Child after release',
        type: c.type,
        parentId: id,
      });
      expect(child.status, JSON.stringify(child.body)).toBe(201);
      const other = await org.owner.post('/accounting/accounts', {
        code: `${c.code}7`,
        name: 'Released leaf',
        type: c.type,
        subtype: c.code === '1130' ? 'ACCOUNTS_RECEIVABLE' : 'ACCOUNTS_PAYABLE',
      });
      expect(other.status, JSON.stringify(other.body)).toBe(201);
    }
    // The released accounts themselves: reclassify, re-currency, move and archive.
    const ar = org.accounts['1130']!;
    const ap = org.accounts['2110']!;
    for (const [id, subtype] of [
      [ar, 'OTHER_CURRENT_ASSET'],
      [ap, 'OTHER_CURRENT_LIABILITY'],
    ] as const) {
      const reclassified = await org.owner.patch(`/accounting/accounts/${id}`, { subtype });
      expect(reclassified.status, JSON.stringify(reclassified.body)).toBe(200);
    }
    const plainAr = (
      await org.owner.post('/accounting/accounts', {
        code: '1139',
        name: 'Plain',
        type: 'ASSET',
        subtype: 'ACCOUNTS_RECEIVABLE',
      })
    ).body.data.id as string;
    const salesAgain = await org.owner.put('/sales/settings', salesSettings(plainAr, 2));
    expect(salesAgain.status, JSON.stringify(salesAgain.body)).toBe(200);
    const releasedAgain = await org.owner.put('/sales/settings', salesSettings(null, 3));
    expect(releasedAgain.status, JSON.stringify(releasedAgain.body)).toBe(200);
    const recurrency = await org.owner.patch(`/accounting/accounts/${plainAr}`, {
      currencyCode: 'USD',
    });
    expect(recurrency.status, JSON.stringify(recurrency.body)).toBe(200);
    const moved = await org.owner.patch(`/accounting/accounts/${plainAr}`, {
      parentId: org.accounts['1100'],
    });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    const archived = await org.owner.post(`/accounting/accounts/${plainAr}/archive`, {});
    expect(archived.status, JSON.stringify(archived.body)).toBe(200);
    const currency = await org.owner.patch('/accounting/settings', { baseCurrency: 'USD' });
    expect(currency.status, JSON.stringify(currency.body)).toBe(200);
  });
});
