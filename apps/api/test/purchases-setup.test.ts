import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inTransaction, setDbContext } from '../src/application/unit-of-work.js';
import { planNumbering } from '../src/modules/documents/index.js';
import {
  DEFAULT_PURCHASE_NUMBERING,
  purchaseDocumentTypes,
  takeNextPurchaseNumber,
} from '../src/modules/purchases/index.js';
import {
  joinWithRole,
  line,
  postJournal,
  setUpAccountingOrg,
  type AccountingOrg,
} from './fixtures.js';
import {
  connectAs,
  createTestContext,
  MINUTE,
  type TestClient,
  type TestContext,
} from './helpers.js';

/**
 * Phase 4A-4 (ADR 0004 P4-05–P4-08, P4-19, P4-26, P4-39, P4-41, P4-42, P4-51): Purchases settings
 * and numbering, the AP control account (through the 4A-1 subledger-control operation) and the
 * purchase side of the shared items catalog with the neutral `catalog.items.manage` key.
 * Nothing here posts.
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

async function gstId(org: AccountingOrg) {
  const codes = (await org.owner.get('/tax/codes')).body.data as { id: string; code: string }[];
  return codes.find((c) => c.code === 'GST')!.id;
}

const baseSettings = (org: AccountingOrg) => ({
  version: 0,
  apAccountId: org.accounts['2110'],
  defaultExpenseAccountId: org.accounts['5400'],
  defaultPaymentAccountId: org.accounts['1120'],
  defaultTaxCodeId: null,
  defaultTaxTreatment: 'exclusive',
  defaultPaymentTermsDays: 30,
});

async function configure(org: AccountingOrg, overrides: object = {}) {
  const res = await org.owner.put('/purchases/settings', { ...baseSettings(org), ...overrides });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data;
}

/** The settings fields of a view, for a follow-up PUT. */
function pick(view: Record<string, unknown>) {
  return {
    version: view.version,
    apAccountId: view.apAccountId,
    defaultExpenseAccountId: view.defaultExpenseAccountId,
    defaultPaymentAccountId: view.defaultPaymentAccountId,
    defaultTaxCodeId: view.defaultTaxCodeId,
    defaultTaxTreatment: view.defaultTaxTreatment,
    defaultPaymentTermsDays: view.defaultPaymentTermsDays,
  };
}

async function control(accountId: string) {
  const { rows } = await owner.query(
    `SELECT is_control_account, control_subledger FROM accounting_accounts WHERE id = $1`,
    [accountId],
  );
  return rows[0] as { is_control_account: boolean; control_subledger: string | null };
}

async function auditActions(org: AccountingOrg, resourceId: string) {
  const { rows } = await owner.query(
    `SELECT action, metadata FROM audit_events WHERE organization_id = $1 AND resource_id = $2
      ORDER BY occurred_at, id`,
    [org.organizationId, resourceId],
  );
  return rows as { action: string; metadata: Record<string, unknown> }[];
}

async function createRole(client: TestClient, name: string, permissionKeys: string[]) {
  const res = await client.post('/organizations/current/roles', { name, permissionKeys });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
}

async function creditCardAccount(org: AccountingOrg) {
  const res = await org.owner.post('/accounting/accounts', {
    code: '2140',
    name: 'Corporate Card',
    type: 'LIABILITY',
    parentId: org.accounts['2100'],
    subtype: 'CREDIT_CARD',
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.id as string;
}

// ---------------------------------------------------------------------------
// Settings and the AP control account
// ---------------------------------------------------------------------------

describe('Purchases settings (P4-07, P4-08)', () => {
  it('shows defaults with a suggested AP account until the first save', async () => {
    const org = await setUpAccountingOrg(ctx);
    const res = await org.owner.get('/purchases/settings');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toEqual({
      configured: false,
      version: 0,
      apAccountId: null,
      defaultExpenseAccountId: null,
      defaultPaymentAccountId: null,
      defaultTaxCodeId: null,
      defaultTaxTreatment: 'exclusive',
      defaultPaymentTermsDays: 30,
      apLocked: false,
      suggestedApAccountId: org.accounts['2110'],
      numbering: {
        bill: { prefix: 'BILL-', minDigits: 5, nextNumber: 1, preview: 'BILL-00001' },
        vendor_credit: { prefix: 'VC-', minDigits: 5, nextNumber: 1, preview: 'VC-00001' },
        debit_note: { prefix: 'DN-', minDigits: 5, nextNumber: 1, preview: 'DN-00001' },
        vendor_payment: { prefix: 'PAY-', minDigits: 5, nextNumber: 1, preview: 'PAY-00001' },
        vendor_refund: { prefix: 'VR-', minDigits: 5, nextNumber: 1, preview: 'VR-00001' },
        expense: { prefix: 'EXP-', minDigits: 5, nextNumber: 1, preview: 'EXP-00001' },
      },
    });
    // Reading creates nothing.
    const { rows } = await owner.query(
      `SELECT count(*)::int AS n FROM purchases_settings WHERE organization_id = $1`,
      [org.organizationId],
    );
    expect(rows[0].n).toBe(0);
  });

  it('saves settings, marks AP as the purchases control account and audits it', async () => {
    const org = await setUpAccountingOrg(ctx);
    const saved = await configure(org, {
      defaultTaxCodeId: await gstId(org),
      defaultPaymentTermsDays: 15,
      numbering: { bill: { prefix: 'PB/', minDigits: 4, nextNumber: 501 } },
    });
    expect(saved).toMatchObject({
      configured: true,
      version: 1,
      apAccountId: org.accounts['2110'],
      defaultPaymentTermsDays: 15,
      suggestedApAccountId: null,
      apLocked: false,
      numbering: { bill: { preview: 'PB/0501' }, expense: { preview: 'EXP-00001' } },
    });
    expect(await control(org.accounts['2110']!)).toEqual({
      is_control_account: true,
      control_subledger: 'purchases',
    });
    const settingsAudit = await auditActions(org, org.organizationId);
    const created = settingsAudit.find((a) => a.action === 'purchases_settings.created');
    expect(created?.metadata).toMatchObject({
      numbering: {
        bill: {
          before: { prefix: 'BILL-', minDigits: 5, nextNumber: 1 },
          after: { prefix: 'PB/', minDigits: 4, nextNumber: 501 },
        },
      },
    });
    expect((await auditActions(org, org.accounts['2110']!)).map((a) => a.action)).toContain(
      'account.control_marked',
    );
    // Every sequence exists after the first save.
    const { rows } = await owner.query(
      `SELECT document_type FROM purchases_number_sequences WHERE organization_id = $1 ORDER BY 1`,
      [org.organizationId],
    );
    expect(rows.map((r) => r.document_type)).toEqual([...purchaseDocumentTypes].sort());

    // C3: manual journals to the AP control account are refused from now on.
    const manual = await org.owner.post('/accounting/journals', {
      entryDate: '2026-03-15',
      description: 'Manual AP',
      currency: 'MVR',
      lines: [
        line(org.accounts['5400']!, 'debit', '10.00'),
        line(org.accounts['2110']!, 'credit', '10.00'),
      ],
    });
    expect(manual.status).toBe(400);

    // Stale versions are refused; any change bumps the version (numbering included).
    const stale = await org.owner.put('/purchases/settings', { ...pick(saved), version: 0 });
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    const renumbered = await org.owner.put('/purchases/settings', {
      ...pick(saved),
      numbering: { vendor_payment: { prefix: 'PV-', minDigits: 6, nextNumber: 40 } },
    });
    expect(renumbered.status, JSON.stringify(renumbered.body)).toBe(200);
    expect(renumbered.body.data).toMatchObject({
      version: 2,
      numbering: { vendor_payment: { preview: 'PV-000040' }, bill: { preview: 'PB/0501' } },
    });
    // An unchanged save is not a change: no version bump, no audit event.
    const before = (await auditActions(org, org.organizationId)).length;
    const same = await org.owner.put('/purchases/settings', pick(renumbered.body.data));
    expect(same.body.data.version).toBe(2);
    expect((await auditActions(org, org.organizationId)).length).toBe(before);
    const backwards = await org.owner.put('/purchases/settings', {
      ...pick(renumbered.body.data),
      numbering: { vendor_payment: { prefix: 'PV-', minDigits: 6, nextNumber: 39 } },
    });
    expect(backwards.status).toBe(400);
    expect(backwards.body.error.details.issues[0]).toEqual({
      path: 'numbering.vendor_payment.nextNumber',
      message: 'The next number cannot be lower than 40.',
    });
  });

  it('moves the control flag when AP changes, releases it on clear, and fixes it once locked', async () => {
    const org = await setUpAccountingOrg(ctx);
    const saved = await configure(org);
    const second = await org.owner.post('/accounting/accounts', {
      code: '2115',
      name: 'Payables - projects',
      type: 'LIABILITY',
      parentId: org.accounts['2100'],
      subtype: 'ACCOUNTS_PAYABLE',
    });
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    const moved = await org.owner.put('/purchases/settings', {
      ...pick(saved),
      apAccountId: second.body.data.id,
    });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(await control(org.accounts['2110']!)).toEqual({
      is_control_account: false,
      control_subledger: null,
    });
    expect(await control(second.body.data.id)).toEqual({
      is_control_account: true,
      control_subledger: 'purchases',
    });
    expect((await auditActions(org, org.accounts['2110']!)).map((a) => a.action)).toContain(
      'account.control_released',
    );
    // Clearing the AP account releases it (missing accounts will block posting later).
    const cleared = await org.owner.put('/purchases/settings', {
      ...pick(moved.body.data),
      apAccountId: null,
    });
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    expect((await control(second.body.data.id)).is_control_account).toBe(false);
    const again = await org.owner.put('/purchases/settings', {
      ...pick(cleared.body.data),
      apAccountId: org.accounts['2110'],
    });
    expect(again.status, JSON.stringify(again.body)).toBe(200);

    // Once the first Purchases document is posted, AP is fixed (API and database).
    await owner.query(
      `UPDATE purchases_settings SET ap_locked_at = now() WHERE organization_id = $1`,
      [org.organizationId],
    );
    const locked = await org.owner.put('/purchases/settings', {
      ...pick(again.body.data),
      apAccountId: second.body.data.id,
    });
    expect(locked.status).toBe(400);
    expect(locked.body.error.details.issues[0]).toEqual({
      path: 'apAccountId',
      message: 'The AP control account cannot change once Purchases documents have been posted.',
    });
    expect((await org.owner.get('/purchases/settings')).body.data.apLocked).toBe(true);
    // Other settings still change while AP is locked.
    const terms = await org.owner.put('/purchases/settings', {
      ...pick(again.body.data),
      defaultPaymentTermsDays: 45,
    });
    expect(terms.status, JSON.stringify(terms.body)).toBe(200);
    await expect(
      owner.query(`UPDATE purchases_settings SET ap_account_id = $2 WHERE organization_id = $1`, [
        org.organizationId,
        second.body.data.id,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      owner.query(`UPDATE purchases_settings SET ap_locked_at = NULL WHERE organization_id = $1`, [
        org.organizationId,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      owner.query(`DELETE FROM purchases_settings WHERE organization_id = $1`, [
        org.organizationId,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('refuses unsuitable AP accounts, including AR, foreign-currency and history outside Purchases', async () => {
    const org = await setUpAccountingOrg(ctx);
    const expectIssue = async (body: object, path: string) => {
      const res = await org.owner.put('/purchases/settings', { ...baseSettings(org), ...body });
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(res.body.error.details.issues.map((i: { path: string }) => i.path)).toContain(path);
    };
    await expectIssue({ apAccountId: org.accounts['2120'] }, 'apAccountId'); // not AP subtype
    await expectIssue({ apAccountId: org.accounts['2100'] }, 'apAccountId'); // parent
    await expectIssue({ apAccountId: org.accounts['1130'] }, 'apAccountId'); // receivables
    const usd = await org.owner.post('/accounting/accounts', {
      code: '2116',
      name: 'Payables USD',
      type: 'LIABILITY',
      parentId: org.accounts['2100'],
      subtype: 'ACCOUNTS_PAYABLE',
      currencyCode: 'USD',
    });
    expect(usd.status, JSON.stringify(usd.body)).toBe(201);
    await expectIssue({ apAccountId: usd.body.data.id }, 'apAccountId');

    // The Sales AR control account can never be claimed by Purchases (one owner per account).
    const sales = await org.owner.put('/sales/settings', {
      version: 0,
      arAccountId: org.accounts['1130'],
      defaultRevenueAccountId: null,
      defaultDepositAccountId: null,
      defaultTaxCodeId: null,
      defaultTaxTreatment: 'exclusive',
      defaultPaymentTermsDays: 30,
    });
    expect(sales.status, JSON.stringify(sales.body)).toBe(200);
    await expectIssue({ apAccountId: org.accounts['1130'] }, 'apAccountId');
    expect(await control(org.accounts['1130']!)).toEqual({
      is_control_account: true,
      control_subledger: 'sales',
    });

    // A payables account that already carries manual postings cannot become the control.
    await postJournal(org, {
      entryDate: '2026-03-15',
      description: 'Legacy payable',
      currency: 'MVR',
      lines: [
        line(org.accounts['5400']!, 'debit', '50.00'),
        line(org.accounts['2110']!, 'credit', '50.00'),
      ],
    });
    await expectIssue({}, 'apAccountId');
    // The suggestion skips an account with postings.
    expect((await org.owner.get('/purchases/settings')).body.data.suggestedApAccountId).toBeNull();
    // Nothing was saved or marked.
    expect((await org.owner.get('/purchases/settings')).body.data.configured).toBe(false);
    expect((await control(org.accounts['2110']!)).is_control_account).toBe(false);
    // Settings without an AP account can still be saved.
    const res = await org.owner.put('/purchases/settings', {
      ...baseSettings(org),
      apAccountId: null,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it('validates default expense and payment accounts and the default tax code', async () => {
    const org = await setUpAccountingOrg(ctx);
    const issuesFor = async (body: object) => {
      const res = await org.owner.put('/purchases/settings', { ...baseSettings(org), ...body });
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      return res.body.error.details.issues as { path: string; message: string }[];
    };
    // P4-19 eligibility for the default expense account.
    expect(await issuesFor({ defaultExpenseAccountId: org.accounts['5000'] })).toContainEqual({
      path: 'defaultExpenseAccountId',
      message: 'Choose a posting (leaf) account.',
    });
    expect(await issuesFor({ defaultExpenseAccountId: org.accounts['5950'] })).toContainEqual({
      path: 'defaultExpenseAccountId',
      message: 'A designated system account cannot be used on purchases.',
    });
    expect(
      (await issuesFor({ defaultExpenseAccountId: org.accounts['4100'] })).map((i) => i.path),
    ).toContain('defaultExpenseAccountId');
    // Fixed assets and other current assets (prepaid, P4-19 clarified) are allowed.
    const assets = await configure(org, { defaultExpenseAccountId: org.accounts['1510'] });
    expect(assets.defaultExpenseAccountId).toBe(org.accounts['1510']);

    // Payment account: bank, cash or credit card (P4-26).
    const card = await creditCardAccount(org);
    const issues = async (body: object) => {
      const res = await org.owner.put('/purchases/settings', { ...pick(assets), ...body });
      return res;
    };
    const bad = await issues({ defaultPaymentAccountId: org.accounts['5400'] });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.issues).toContainEqual({
      path: 'defaultPaymentAccountId',
      message: 'Choose a bank, cash or credit card account (Decision 42, P4-26).',
    });
    const cardSaved = await issues({ defaultPaymentAccountId: card });
    expect(cardSaved.status, JSON.stringify(cardSaved.body)).toBe(200);
    const cash = await org.owner.put('/purchases/settings', {
      ...pick(cardSaved.body.data),
      defaultPaymentAccountId: org.accounts['1110'],
    });
    expect(cash.status, JSON.stringify(cash.body)).toBe(200);

    // An archived tax code is refused.
    const gst = await gstId(org);
    const codes = (await org.owner.get('/tax/codes')).body.data as {
      id: string;
      version: number;
    }[];
    const archived = await org.owner.post(`/tax/codes/${gst}/archive`, {
      version: codes.find((c) => c.id === gst)!.version,
    });
    expect(archived.status, JSON.stringify(archived.body)).toBe(200);
    const taxed = await org.owner.put('/purchases/settings', {
      ...pick(cash.body.data),
      defaultTaxCodeId: gst,
    });
    expect(taxed.status).toBe(400);
    expect(taxed.body.error.details.issues).toContainEqual({
      path: 'defaultTaxCodeId',
      message: 'Choose an active tax code.',
    });
    // Unknown fields and bad numbering are refused by the strict schema.
    const extra = await org.owner.put('/purchases/settings', {
      ...pick(cash.body.data),
      duplicateBillCheck: 'block',
    });
    expect(extra.status).toBe(400);
    const prefix = await org.owner.put('/purchases/settings', {
      ...pick(cash.body.data),
      numbering: { bill: { prefix: 'BILL 1', minDigits: 5, nextNumber: 1 } },
    });
    expect(prefix.status).toBe(400);
  });

  it('needs purchases.settings.manage (MFA-required) and a recent password to change', async () => {
    const org = await setUpAccountingOrg(ctx);
    // Members and Administrators of existing roles: Member cannot read or change.
    const member = await joinWithRole(ctx, org.owner, 'Member');
    expect((await member.client.get('/purchases/settings')).status).toBe(403);
    expect((await member.client.put('/purchases/settings', baseSettings(org))).status).toBe(403);
    await createRole(org.owner, 'Vendors only', ['vendors.view', 'vendors.update']);
    const vendorsOnly = await joinWithRole(ctx, org.owner, 'Vendors only');
    expect((await vendorsOnly.client.get('/purchases/settings')).status).toBe(403);

    // A holder of the key must use two-step verification (P4-41).
    await createRole(org.owner, 'Purchases admin', ['purchases.settings.manage']);
    const admin = await joinWithRole(ctx, org.owner, 'Purchases admin');
    const session = (await admin.client.get('/auth/session')).body.data;
    expect(session.mfa.activeOrganization.reasons).toContain('privileged_permission');
    expect((await admin.client.get('/purchases/settings')).status).toBe(200);
    const saved = await admin.client.put('/purchases/settings', {
      ...baseSettings(org),
      apAccountId: null,
      defaultExpenseAccountId: null,
      defaultPaymentAccountId: null,
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);

    // A recent password confirmation is needed to save (P4-42).
    ctx.clock.advance(16 * MINUTE);
    await org.owner.get('/auth/session');
    const stale = await org.owner.put('/purchases/settings', {
      ...pick(saved.body.data),
      defaultPaymentTermsDays: 10,
    });
    expect(stale.body.error.code).toBe('REAUTHENTICATION_REQUIRED');
  });

  it('keeps settings tenant-isolated (RLS)', async () => {
    const a = await setUpAccountingOrg(ctx);
    const b = await setUpAccountingOrg(ctx);
    await configure(a);
    const app = await connectAs('app');
    try {
      await app.query('BEGIN');
      await app.query(`SELECT set_config('app.organization_id', $1, true)`, [b.organizationId]);
      const settings = await app.query(`SELECT * FROM purchases_settings`);
      const sequences = await app.query(`SELECT * FROM purchases_number_sequences`);
      expect(settings.rows).toEqual([]);
      expect(sequences.rows).toEqual([]);
      await expect(
        app.query(
          `INSERT INTO purchases_settings (organization_id, created_by_user_id, created_at, updated_at)
           SELECT $1, created_by_user_id, now(), now() FROM accounting_settings LIMIT 1`,
          [a.organizationId],
        ),
      ).rejects.toBeTruthy();
    } finally {
      await app.query('ROLLBACK');
      await app.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Numbering (P4-51; R37)
// ---------------------------------------------------------------------------

describe('Purchases numbering (P4-51)', () => {
  it('plans numbering per type and never lowers the next number', () => {
    const existing = purchaseDocumentTypes.map((documentType) => ({
      documentType,
      ...DEFAULT_PURCHASE_NUMBERING[documentType],
      nextNumber: 10,
    }));
    const plan = planNumbering({
      types: purchaseDocumentTypes,
      existing,
      defaults: DEFAULT_PURCHASE_NUMBERING,
      wanted: {
        bill: { prefix: 'B-', minDigits: 3, nextNumber: 10 },
        expense: { prefix: 'EXP-', minDigits: 5, nextNumber: 9 },
      },
    });
    expect(plan.changes.bill).toEqual({
      before: { prefix: 'BILL-', minDigits: 5, nextNumber: 10 },
      after: { prefix: 'B-', minDigits: 3, nextNumber: 10 },
    });
    expect(plan.changes.vendor_payment).toBeUndefined();
    expect(plan.issues).toEqual([
      {
        path: 'numbering.expense.nextNumber',
        message: 'The next number cannot be lower than 10.',
      },
    ]);
  });

  it('takes numbers in order, concurrently distinct, and never moves a sequence backwards', async () => {
    const org = await setUpAccountingOrg(ctx);
    await configure(org, {
      numbering: { bill: { prefix: 'BILL-', minDigits: 3, nextNumber: 998 } },
    });
    const who = {
      organizationId: org.organizationId,
      userId: (await org.owner.get('/auth/session')).body.data.user.id as string,
    };
    const take = (type: 'bill' | 'expense' = 'bill') =>
      inTransaction(ctx.database.db, who, async (tx) => {
        await setDbContext(tx, who);
        return takeNextPurchaseNumber(tx, org.organizationId, type);
      });
    const numbers = [];
    for (let i = 0; i < 3; i += 1) numbers.push((await take())!.number);
    expect(numbers).toEqual(['BILL-998', 'BILL-999', 'BILL-1000']);
    // Each type has its own sequence.
    expect((await take('expense'))!.number).toBe('EXP-00001');
    const concurrent = await Promise.all([take(), take(), take(), take()]);
    expect(new Set(concurrent.map((n) => n!.number)).size).toBe(4);
    // A rolled-back taker leaves a gap (numbering is not gapless, R37).
    await expect(
      inTransaction(ctx.database.db, who, async (tx) => {
        await setDbContext(tx, who);
        await takeNextPurchaseNumber(tx, org.organizationId, 'bill');
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');
    expect((await take())!.number).toBe('BILL-1005');
    await expect(
      owner.query(
        `UPDATE purchases_number_sequences SET next_number = 1
          WHERE organization_id = $1 AND document_type = 'bill'`,
        [org.organizationId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      owner.query(`DELETE FROM purchases_number_sequences WHERE organization_id = $1`, [
        org.organizationId,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

// ---------------------------------------------------------------------------
// The shared items catalog (P4-05, P4-06)
// ---------------------------------------------------------------------------

describe('catalog purchase fields (P4-05)', () => {
  it('keeps existing behavior: new items are sold and not purchased by default', async () => {
    const org = await setUpAccountingOrg(ctx);
    const res = await org.owner.post('/sales/items', {
      name: 'Consulting hour',
      itemType: 'service',
      unitPrice: '250',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({
      isSold: true,
      isPurchased: false,
      purchaseDescription: '',
      purchaseUnitCost: null,
      expenseAccountId: null,
      purchaseTaxCodeId: null,
    });
  });

  it('stores purchase defaults and validates them', async () => {
    const org = await setUpAccountingOrg(ctx);
    const gst = await gstId(org);
    const created = await org.owner.post('/sales/items', {
      name: 'Printer paper',
      itemType: 'product',
      isSold: false,
      isPurchased: true,
      purchaseDescription: '  A4 80gsm, box of 5  ',
      purchaseUnitCost: '42.5',
      expenseAccountId: org.accounts['5900'],
      purchaseTaxCodeId: gst,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data).toMatchObject({
      isSold: false,
      isPurchased: true,
      purchaseDescription: 'A4 80gsm, box of 5',
      purchaseUnitCost: '42.50',
      expenseAccountId: org.accounts['5900'],
      purchaseTaxCodeId: gst,
    });
    const { rows } = await owner.query(`SELECT purchase_unit_cost FROM sales_items WHERE id = $1`, [
      created.body.data.id,
    ]);
    expect(rows[0].purchase_unit_cost).toBe('42.5000');

    const issuesFor = async (body: object) => {
      const res = await org.owner.post('/sales/items', {
        name: `Item ${Math.random()}`,
        itemType: 'product',
        isPurchased: true,
        ...body,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      return res.body.error.details.issues as { path: string; message: string }[];
    };
    expect(await issuesFor({ isSold: false, isPurchased: false })).toContainEqual({
      path: 'isSold',
      message: 'An item is sold, purchased, or both.',
    });
    expect(await issuesFor({ expenseAccountId: org.accounts['5950'] })).toContainEqual({
      path: 'expenseAccountId',
      message: 'A designated system account cannot be used on purchases.',
    });
    expect(await issuesFor({ expenseAccountId: org.accounts['5000'] })).toContainEqual({
      path: 'expenseAccountId',
      message: 'Choose a posting (leaf) account.',
    });
    expect((await issuesFor({ purchaseUnitCost: '1.23456' })).length).toBeGreaterThan(0);
    expect((await issuesFor({ purchaseUnitCost: '-1' })).length).toBeGreaterThan(0);

    // A control account is never a purchase account (here: AP after the settings mark it).
    await configure(org);
    expect(await issuesFor({ expenseAccountId: org.accounts['2110'] })).toContainEqual({
      path: 'expenseAccountId',
      message: 'A control account cannot be used on purchases.',
    });

    // Update keeps omitted purchase fields; the facet rule applies to the merged result.
    const item = created.body.data;
    const renamed = await org.owner.patch(`/sales/items/${item.id}`, {
      version: item.version,
      name: 'Printer paper (A4)',
    });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    expect(renamed.body.data).toMatchObject({
      isPurchased: true,
      purchaseUnitCost: '42.50',
      expenseAccountId: org.accounts['5900'],
    });
    const none = await org.owner.patch(`/sales/items/${item.id}`, {
      version: renamed.body.data.version,
      isPurchased: false,
    });
    expect(none.status).toBe(400);
    await expect(
      owner.query(`UPDATE sales_items SET is_purchased = false WHERE id = $1`, [item.id]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('refuses an item that is not sold on Sales documents', async () => {
    const org = await setUpAccountingOrg(ctx);
    const settings = await org.owner.put('/sales/settings', {
      version: 0,
      arAccountId: org.accounts['1130'],
      defaultRevenueAccountId: org.accounts['4100'],
      defaultDepositAccountId: org.accounts['1120'],
      defaultTaxCodeId: null,
      defaultTaxTreatment: 'exclusive',
      defaultPaymentTermsDays: 30,
    });
    expect(settings.status, JSON.stringify(settings.body)).toBe(200);
    const customer = await org.owner.post('/customers', {
      party: { kind: 'organization', displayName: 'Reef Hotel' },
    });
    const item = await org.owner.post('/sales/items', {
      name: 'Office supplies',
      itemType: 'product',
      isSold: false,
      isPurchased: true,
    });
    const res = await org.owner.post('/sales/invoices', {
      customerId: customer.body.data.id,
      invoiceDate: '2026-03-10',
      lines: [{ itemId: item.body.data.id, description: 'x', quantity: '1', unitPrice: '10' }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.details.issues).toContainEqual({
      path: 'lines.0.itemId',
      message: 'Office supplies is not sold.',
    });
  });

  it('governs the catalog with catalog.items.manage, keeping sales.items.manage working', async () => {
    const org = await setUpAccountingOrg(ctx);
    await createRole(org.owner, 'Catalog', ['catalog.items.manage']);
    await createRole(org.owner, 'Legacy items', ['sales.items.manage']);
    await createRole(org.owner, 'Vendors', ['vendors.view']);
    const catalog = await joinWithRole(ctx, org.owner, 'Catalog');
    const legacy = await joinWithRole(ctx, org.owner, 'Legacy items');
    const vendors = await joinWithRole(ctx, org.owner, 'Vendors');
    const member = await joinWithRole(ctx, org.owner, 'Member');
    const body = { name: 'Diesel', itemType: 'product', isSold: false, isPurchased: true };

    const made = await catalog.client.post('/sales/items', body);
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect((await catalog.client.get('/sales/items')).status).toBe(200);
    const legacyMade = await legacy.client.post('/sales/items', { ...body, name: 'Petrol' });
    expect(legacyMade.status, JSON.stringify(legacyMade.body)).toBe(201);
    const archived = await legacy.client.post(`/sales/items/${made.body.data.id}/archive`, {
      version: made.body.data.version,
    });
    expect(archived.status, JSON.stringify(archived.body)).toBe(200);

    // Member views (invoices.view) but cannot change; a vendors-only role sees nothing yet.
    expect((await member.client.get('/sales/items')).status).toBe(200);
    expect((await member.client.post('/sales/items', body)).status).toBe(403);
    expect((await vendors.client.get('/sales/items')).status).toBe(403);
    expect((await vendors.client.post('/sales/items', body)).status).toBe(403);

    // New organizations: Owner and Administrator hold both new keys; Member neither.
    const { rows } = await owner.query(
      `SELECT r.name, array_agg(rp.permission_key ORDER BY rp.permission_key) AS keys
         FROM roles r JOIN role_permissions rp ON rp.role_id = r.id
        WHERE r.organization_id = $1
          AND rp.permission_key IN ('catalog.items.manage', 'purchases.settings.manage')
        GROUP BY r.name ORDER BY r.name`,
      [org.organizationId],
    );
    expect(rows).toEqual([
      { name: 'Administrator', keys: ['catalog.items.manage', 'purchases.settings.manage'] },
      { name: 'Catalog', keys: ['catalog.items.manage'] },
      { name: 'Owner', keys: ['catalog.items.manage', 'purchases.settings.manage'] },
    ]);
  });
});
