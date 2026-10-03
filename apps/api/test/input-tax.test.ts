import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readMigrationFiles } from '../src/database/migrator.js';
import { decimal } from '../src/domain/money.js';
import { coaTemplateDefinitions } from '../src/modules/accounting/index.js';
import { buildDocumentJournal, buildPurchaseJournal } from '../src/modules/documents/index.js';
import {
  defaultTaxRecoverable,
  gstRegisteredOn,
  lineTax,
  purchaseTaxCodeProblem,
  splitLineTax,
} from '../src/modules/tax/index.js';
import { joinWithRole, setUpAccountingOrg, type AccountingOrg } from './fixtures.js';
import { connectAs, createTestContext, MINUTE, type TestContext } from './helpers.js';

/**
 * Phase 4 input-tax stage (ADR 0004 P4-11, P4-12, P4-13): the input tax account on tax codes,
 * recoverability defaults on vendors and catalog items, the pure purchase tax rules and the
 * purchase journal shape. Bills (which persist and post purchase lines) come later; Sales output
 * tax is unchanged.
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

interface CodeView {
  id: string;
  code: string;
  taxAccountId: string;
  inputTaxAccountId: string | null;
  version: number;
  status: string;
  rates: { rate: string; effectiveFrom: string }[];
}

async function codes(org: AccountingOrg) {
  const res = await org.owner.get('/tax/codes');
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data as CodeView[];
}

async function auditOf(org: AccountingOrg, resourceId: string) {
  const { rows } = await owner.query(
    `SELECT action, metadata FROM audit_events WHERE organization_id = $1 AND resource_id = $2
      ORDER BY occurred_at, id`,
    [org.organizationId, resourceId],
  );
  return rows as { action: string; metadata: Record<string, unknown> }[];
}

async function newAccount(org: AccountingOrg, body: Record<string, unknown>) {
  const res = await org.owner.post('/accounting/accounts', body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.id as string;
}

// ---------------------------------------------------------------------------
// P4-13: template and seed
// ---------------------------------------------------------------------------

describe('template input tax account (P4-13)', () => {
  it('adds 1160 to the Maldives template only, and maps the seeded GST codes to it', async () => {
    const byKey = Object.fromEntries(coaTemplateDefinitions.map((t) => [t.key, t.accounts]));
    expect(byKey.maldives!.find((a) => a.code === '1160')).toEqual({
      code: '1160',
      name: 'GST Input Tax Recoverable',
      type: 'ASSET',
      parentCode: '1100',
      subtype: 'OTHER_CURRENT_ASSET',
    });
    for (const key of ['india', 'uae', 'uk', 'custom']) {
      expect(byKey[key]!.some((a) => a.code === '1160')).toBe(false);
    }
    // No PREPAID_EXPENSE subtype: 1150 Prepaid Expenses stays OTHER_CURRENT_ASSET.
    expect(byKey.maldives!.find((a) => a.code === '1150')?.subtype).toBe('OTHER_CURRENT_ASSET');

    const org = await setUpAccountingOrg(ctx);
    const account = (await org.owner.get(`/accounting/accounts/${org.accounts['1160']}`)).body.data;
    expect(account).toMatchObject({
      code: '1160',
      type: 'ASSET',
      subtype: 'OTHER_CURRENT_ASSET',
      currencyCode: 'MVR',
      isControlAccount: false,
    });
    const seeded = await codes(org);
    expect(seeded.map((c) => [c.code, c.taxAccountId, c.inputTaxAccountId])).toEqual([
      ['GST', org.accounts['2130'], org.accounts['1160']],
      ['TGST', org.accounts['2130'], org.accounts['1160']],
    ]);
    // Rates and their effective dating are unchanged.
    expect(seeded.find((c) => c.code === 'TGST')!.rates.map((r) => r.effectiveFrom)).toEqual([
      '2023-01-01',
      '2025-07-01',
    ]);
  });

  it('never maps existing organizations: migration 0032 only adds nullable columns', () => {
    const sql = readMigrationFiles().find((m) => m.version === '0032_input_tax')!.sql;
    const statements = sql
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n');
    expect(statements).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/i);
    expect(statements).toMatch(/ADD COLUMN input_tax_account_id uuid,/);
    expect(statements).not.toMatch(/NOT NULL/);
  });

  it('leaves codes without an input account usable for Sales but blocked for purchases', async () => {
    const org = await setUpAccountingOrg(ctx);
    const gst = (await codes(org)).find((c) => c.code === 'GST')!;
    // An existing organization's code: no input account yet (simulated by clearing it).
    const cleared = await org.owner.patch(`/tax/codes/${gst.id}`, {
      version: gst.version,
      inputTaxAccountId: null,
    });
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    expect(cleared.body.data.inputTaxAccountId).toBeNull();
    expect(purchaseTaxCodeProblem(cleared.body.data, null)).toBe(
      'GST has no input tax account. Set one under Tax codes before using it on purchases.',
    );
    // Sales settings still accept it as the default (output tax is unchanged).
    const sales = await org.owner.put('/sales/settings', {
      version: 0,
      arAccountId: org.accounts['1130'],
      defaultRevenueAccountId: org.accounts['4100'],
      defaultDepositAccountId: org.accounts['1120'],
      defaultTaxCodeId: gst.id,
      defaultTaxTreatment: 'exclusive',
      defaultPaymentTermsDays: 30,
    });
    expect(sales.status, JSON.stringify(sales.body)).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// P4-11: the input tax account on tax codes
// ---------------------------------------------------------------------------

describe('tax code input tax account (P4-11)', () => {
  it('creates and changes the mapping with validation and audit; output tax is untouched', async () => {
    const org = await setUpAccountingOrg(ctx);
    const created = await org.owner.post('/tax/codes', {
      code: 'IMP',
      name: 'Import GST',
      taxAccountId: org.accounts['2130'],
      inputTaxAccountId: org.accounts['1160'],
      rate: '8',
      effectiveFrom: '2026-01-01',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data).toMatchObject({
      taxAccountId: org.accounts['2130'],
      inputTaxAccountId: org.accounts['1160'],
    });
    const audit = await auditOf(org, created.body.data.id);
    expect(audit[0]).toMatchObject({
      action: 'tax_code.created',
      metadata: { inputTaxAccountId: org.accounts['1160'] },
    });
    // Without an input account is allowed (optional on the code).
    const plain = await org.owner.post('/tax/codes', {
      code: 'ZR',
      name: 'Zero rated',
      taxAccountId: org.accounts['2130'],
      rate: '0',
      effectiveFrom: '2026-01-01',
    });
    expect(plain.status, JSON.stringify(plain.body)).toBe(201);
    expect(plain.body.data.inputTaxAccountId).toBeNull();

    const other = await newAccount(org, {
      code: '1165',
      name: 'Input tax - imports',
      type: 'ASSET',
      parentId: org.accounts['1100'],
      subtype: 'OTHER_CURRENT_ASSET',
    });
    const moved = await org.owner.patch(`/tax/codes/${created.body.data.id}`, {
      version: created.body.data.version,
      inputTaxAccountId: other,
    });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body.data).toMatchObject({
      inputTaxAccountId: other,
      taxAccountId: org.accounts['2130'],
      version: created.body.data.version + 1,
    });
    const updated = (await auditOf(org, created.body.data.id)).at(-1)!;
    expect(updated).toMatchObject({
      action: 'tax_code.updated',
      metadata: {
        before: { inputTaxAccountId: org.accounts['1160'] },
        after: { inputTaxAccountId: other },
      },
    });
    const stale = await org.owner.patch(`/tax/codes/${created.body.data.id}`, {
      version: created.body.data.version,
      inputTaxAccountId: org.accounts['1160'],
    });
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
  });

  it('accepts only an active, leaf, base-currency, non-control asset', async () => {
    const org = await setUpAccountingOrg(ctx);
    const gst = (await codes(org)).find((c) => c.code === 'GST')!;
    const refuse = async (accountId: string, message: string) => {
      const fresh = (await codes(org)).find((c) => c.code === 'GST')!;
      const res = await org.owner.patch(`/tax/codes/${gst.id}`, {
        version: fresh.version,
        inputTaxAccountId: accountId,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(res.body.error.details.issues).toEqual([{ path: 'inputTaxAccountId', message }]);
    };
    await refuse(org.accounts['2130']!, 'The input tax account must be an asset.');
    await refuse(org.accounts['5400']!, 'The input tax account must be an asset.');
    await refuse(org.accounts['1100']!, 'The input tax account must be a posting (leaf) account.');
    const usd = await newAccount(org, {
      code: '1166',
      name: 'Input tax USD',
      type: 'ASSET',
      parentId: org.accounts['1100'],
      subtype: 'OTHER_CURRENT_ASSET',
      currencyCode: 'USD',
    });
    await refuse(usd, 'The input tax account must be in the base currency.');
    const sales = await org.owner.put('/sales/settings', {
      version: 0,
      arAccountId: org.accounts['1130'],
      defaultRevenueAccountId: null,
      defaultDepositAccountId: null,
      defaultTaxCodeId: null,
      defaultTaxTreatment: 'exclusive',
      defaultPaymentTermsDays: 30,
    });
    expect(sales.status).toBe(200);
    await refuse(org.accounts['1130']!, 'A control account cannot be an input tax account.');
    const archived = await newAccount(org, {
      code: '1167',
      name: 'Old input tax',
      type: 'ASSET',
      parentId: org.accounts['1100'],
      subtype: 'OTHER_CURRENT_ASSET',
    });
    expect((await org.owner.post(`/accounting/accounts/${archived}/archive`)).status).toBe(200);
    await refuse(archived, 'The input tax account must be active.');
    // Another organization's account is not found (tenant isolation).
    const b = await setUpAccountingOrg(ctx);
    await refuse(b.accounts['1160']!, 'Account not found.');
    // Strict schema.
    const bad = await org.owner.patch(`/tax/codes/${gst.id}`, {
      version: gst.version,
      inputTaxAccount: org.accounts['1160'],
    });
    expect(bad.status).toBe(400);
  });

  it('re-checks the input account when an archived code is restored', async () => {
    const org = await setUpAccountingOrg(ctx);
    const input = await newAccount(org, {
      code: '1168',
      name: 'Input tax (temp)',
      type: 'ASSET',
      parentId: org.accounts['1100'],
      subtype: 'OTHER_CURRENT_ASSET',
    });
    const code = await org.owner.post('/tax/codes', {
      code: 'TMP',
      name: 'Temporary',
      taxAccountId: org.accounts['2130'],
      inputTaxAccountId: input,
      rate: '5',
      effectiveFrom: '2026-01-01',
    });
    expect(code.status, JSON.stringify(code.body)).toBe(201);
    const archivedCode = await org.owner.post(`/tax/codes/${code.body.data.id}/archive`, {
      version: code.body.data.version,
    });
    expect(archivedCode.status).toBe(200);
    expect((await org.owner.post(`/accounting/accounts/${input}/archive`)).status).toBe(200);
    const restore = await org.owner.post(`/tax/codes/${code.body.data.id}/restore`, {
      version: archivedCode.body.data.version,
    });
    expect(restore.status).toBe(400);
    expect(restore.body.error.details.issues[0].path).toBe('inputTaxAccountId');
  });

  it('needs tax.codes.manage and a recent password; others cannot change it', async () => {
    const org = await setUpAccountingOrg(ctx);
    const gst = (await codes(org)).find((c) => c.code === 'GST')!;
    const member = await joinWithRole(ctx, org.owner, 'Member');
    const denied = await member.client.patch(`/tax/codes/${gst.id}`, {
      version: gst.version,
      inputTaxAccountId: null,
    });
    expect(denied.status).toBe(403);
    ctx.clock.advance(16 * MINUTE);
    await org.owner.get('/auth/session');
    const stale = await org.owner.patch(`/tax/codes/${gst.id}`, {
      version: gst.version,
      inputTaxAccountId: null,
    });
    expect(stale.body.error.code).toBe('REAUTHENTICATION_REQUIRED');
    expect((await codes(org)).find((c) => c.code === 'GST')!.inputTaxAccountId).toBe(
      org.accounts['1160'],
    );
  });

  it('keeps tax codes tenant-isolated at the database (RLS)', async () => {
    const a = await setUpAccountingOrg(ctx);
    const b = await setUpAccountingOrg(ctx);
    const app = await connectAs('app');
    try {
      await app.query('BEGIN');
      await app.query(`SELECT set_config('app.organization_id', $1, true)`, [b.organizationId]);
      const { rows } = await app.query(`SELECT id FROM tax_codes WHERE organization_id = $1`, [
        a.organizationId,
      ]);
      expect(rows).toEqual([]);
      // A code cannot reference another organization's account (composite tenant FK).
      await expect(
        app.query(`UPDATE tax_codes SET input_tax_account_id = $1 WHERE organization_id = $2`, [
          a.accounts['1160'],
          b.organizationId,
        ]),
      ).rejects.toMatchObject({ code: '23503' });
    } finally {
      await app.query('ROLLBACK');
      await app.end();
    }
  });
});

// ---------------------------------------------------------------------------
// P4-12: recoverability defaults on vendors and items
// ---------------------------------------------------------------------------

describe('recoverability defaults (P4-12)', () => {
  it('stores an optional vendor default, audited', async () => {
    const org = await setUpAccountingOrg(ctx);
    const created = await org.owner.post('/vendors', {
      party: { kind: 'organization', displayName: 'Fuel Supplier' },
      defaultTaxRecoverable: false,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data.defaultTaxRecoverable).toBe(false);
    const plain = await org.owner.post('/vendors', {
      party: { kind: 'organization', displayName: 'Stationer' },
    });
    expect(plain.body.data.defaultTaxRecoverable).toBeNull();
    const updated = await org.owner.patch(`/vendors/${created.body.data.id}`, {
      version: created.body.data.version,
      defaultTaxRecoverable: null,
    });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body.data.defaultTaxRecoverable).toBeNull();
    expect((await auditOf(org, created.body.data.id)).at(-1)!.metadata).toMatchObject({
      changedFields: ['defaultTaxRecoverable'],
      before: { defaultTaxRecoverable: false },
      after: { defaultTaxRecoverable: null },
    });
    const bad = await org.owner.patch(`/vendors/${created.body.data.id}`, {
      version: updated.body.data.version,
      defaultTaxRecoverable: 'yes',
    });
    expect(bad.status).toBe(400);
  });

  it('stores an optional item default; omitted means no default', async () => {
    const org = await setUpAccountingOrg(ctx);
    const item = await org.owner.post('/sales/items', {
      name: 'Diesel',
      itemType: 'product',
      isSold: false,
      isPurchased: true,
      purchaseTaxRecoverable: false,
    });
    expect(item.status, JSON.stringify(item.body)).toBe(201);
    expect(item.body.data.purchaseTaxRecoverable).toBe(false);
    const renamed = await org.owner.patch(`/sales/items/${item.body.data.id}`, {
      version: item.body.data.version,
      name: 'Diesel (bulk)',
    });
    expect(renamed.body.data.purchaseTaxRecoverable).toBe(false);
    const sold = await org.owner.post('/sales/items', { name: 'Consulting', itemType: 'service' });
    expect(sold.body.data.purchaseTaxRecoverable).toBeNull();
  });

  it('defaults from GST registration on the date, then item, then vendor, then recoverable', () => {
    type Org = { gstRegistered: boolean; gstRegisteredFrom: string | null };
    const registered: Org = { gstRegistered: true, gstRegisteredFrom: '2026-03-01' };
    const unregistered: Org = { gstRegistered: false, gstRegisteredFrom: null };
    const base = { itemDefault: null, vendorDefault: null };
    expect(gstRegisteredOn(registered, '2026-02-28')).toBe(false);
    expect(gstRegisteredOn(registered, '2026-03-01')).toBe(true);
    expect(gstRegisteredOn({ gstRegistered: true, gstRegisteredFrom: null }, '2020-01-01')).toBe(
      true,
    );
    const d = (organization: Org, date: string, extra = {}) =>
      defaultTaxRecoverable({ organization, documentDate: date, ...base, ...extra });
    expect(d(unregistered, '2026-04-01', { itemDefault: true, vendorDefault: true })).toBe(false);
    expect(d(registered, '2026-02-01', { itemDefault: true })).toBe(false); // before registration
    expect(d(registered, '2026-04-01')).toBe(true);
    expect(d(registered, '2026-04-01', { vendorDefault: false })).toBe(false);
    expect(d(registered, '2026-04-01', { itemDefault: true, vendorDefault: false })).toBe(true);
    expect(d(registered, '2026-04-01', { itemDefault: false, vendorDefault: true })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Pure purchase tax and journal rules (used by Bills)
// ---------------------------------------------------------------------------

describe('purchase tax posting rules (P4-11, P4-12)', () => {
  const typeOf = new Map([
    ['dim-a', 'type-1'],
    ['dim-b', 'type-1'],
  ]);

  it('blocks codes without a usable input account, with guidance', () => {
    const code = { code: 'GST', status: 'ACTIVE', inputTaxAccountId: 'acc-1160' };
    const asset = { status: 'ACTIVE', isLeaf: true, accountType: 'ASSET', isControlAccount: false };
    expect(purchaseTaxCodeProblem(code, asset)).toBeNull();
    expect(purchaseTaxCodeProblem({ ...code, status: 'ARCHIVED' }, asset)).toBe('GST is archived.');
    expect(purchaseTaxCodeProblem(code, { ...asset, status: 'ARCHIVED' })).toMatch(/is archived/);
    expect(purchaseTaxCodeProblem(code, { ...asset, accountType: 'LIABILITY' })).toMatch(
      /no longer a usable asset/,
    );
    expect(purchaseTaxCodeProblem(code, null)).toMatch(/was not found/);
  });

  it('splits tax all-or-nothing by recoverability', () => {
    expect(splitLineTax(decimal('8.00'), true)).toEqual({
      recoverableTax: decimal('8.00'),
      nonRecoverableTax: decimal(0),
    });
    expect(splitLineTax(decimal('8.00'), false)).toEqual({
      recoverableTax: decimal(0),
      nonRecoverableTax: decimal('8.00'),
    });
  });

  it('posts recoverable tax to the input account and capitalizes non-recoverable tax', () => {
    // Line 1: 100 net, GST 8 recoverable. Line 2: 50 net, GST 4 not recoverable (same account).
    // Line 3: 200 net on another account, no tax.
    const journal = buildPurchaseJournal({
      direction: 'bill',
      documentLabel: 'BILL-00001',
      apAccountId: 'ap',
      documentDimensionValueIds: [],
      typeOf,
      lines: [
        {
          accountId: 'exp',
          dimensionValueIds: [],
          net: decimal(100),
          nonRecoverableTax: decimal(0),
        },
        {
          accountId: 'exp',
          dimensionValueIds: [],
          net: decimal(50),
          nonRecoverableTax: decimal(4),
        },
        {
          accountId: 'fa',
          dimensionValueIds: [],
          net: decimal(200),
          nonRecoverableTax: decimal(0),
        },
      ],
      inputTaxes: [{ taxCodeId: 'gst', label: 'GST 8%', accountId: 'input', amount: decimal(8) }],
      currency: 'MVR',
      baseCurrency: 'MVR',
      rate: decimal(1),
    });
    const summary = journal.lines.map((l) => [l.role, l.accountId, l.side, l.amount.toFixed(2)]);
    expect(summary).toEqual([
      ['payable', 'ap', 'credit', '362.00'],
      ['expense', 'exp', 'debit', '154.00'],
      ['expense', 'fa', 'debit', '200.00'],
      ['tax', 'input', 'debit', '8.00'],
    ]);
    expect(journal.total.toFixed(2)).toBe('362.00');
    const debits = journal.lines.filter((l) => l.side === 'debit');
    const sum = debits.reduce((s, l) => s.plus(l.baseAmount), decimal(0));
    expect(sum.toFixed(2)).toBe(journal.baseTotal.toFixed(2));
  });

  it('converts to base balanced and merges document dimensions (D10)', () => {
    const journal = buildPurchaseJournal({
      direction: 'bill',
      documentLabel: 'BILL-00002',
      apAccountId: 'ap',
      documentDimensionValueIds: ['dim-b'],
      typeOf,
      lines: [
        {
          accountId: 'exp',
          dimensionValueIds: ['dim-a'],
          net: decimal('33.33'),
          nonRecoverableTax: decimal(0),
        },
        {
          accountId: 'exp',
          dimensionValueIds: [],
          net: decimal('66.67'),
          nonRecoverableTax: decimal('5.33'),
        },
      ],
      inputTaxes: [{ taxCodeId: 'gst', label: 'GST', accountId: 'input', amount: decimal('2.67') }],
      currency: 'USD',
      baseCurrency: 'MVR',
      rate: decimal('15.42'),
    });
    expect(
      journal.lines.find((l) => l.role === 'expense' && l.amount.eq('33.33'))!.dimensionValueIds,
    ).toEqual(['dim-a']);
    expect(journal.lines.find((l) => l.amount.eq('72.00'))!.dimensionValueIds).toEqual(['dim-b']);
    const debit = journal.lines
      .filter((l) => l.side === 'debit')
      .reduce((s, l) => s.plus(l.baseAmount), decimal(0));
    const credit = journal.lines
      .filter((l) => l.side === 'credit')
      .reduce((s, l) => s.plus(l.baseAmount), decimal(0));
    expect(debit.toFixed(2)).toBe(credit.toFixed(2));
    expect(journal.baseTotal.toFixed(2)).toBe(credit.toFixed(2));
  });

  it('vendor credits are the exact reverse, and the Sales builder output is unchanged', () => {
    const input = {
      documentLabel: 'X',
      apAccountId: 'ap',
      documentDimensionValueIds: [],
      typeOf,
      lines: [
        {
          accountId: 'exp',
          dimensionValueIds: [],
          net: decimal(10),
          nonRecoverableTax: decimal(1),
        },
      ],
      inputTaxes: [],
      currency: 'MVR',
      baseCurrency: 'MVR',
      rate: decimal(1),
    };
    const bill = buildPurchaseJournal({ ...input, direction: 'bill' });
    const credit = buildPurchaseJournal({ ...input, direction: 'vendor_credit' });
    expect(credit.lines.map((l) => l.side)).toEqual(
      bill.lines.map((l) => (l.side === 'debit' ? 'credit' : 'debit')),
    );
    const sales = buildDocumentJournal({
      direction: 'invoice',
      documentLabel: 'INV',
      arAccountId: 'ar',
      documentDimensionValueIds: [],
      typeOf,
      revenue: [{ accountId: 'rev', dimensionValueIds: [], net: decimal(100) }],
      taxes: [{ taxCodeId: 'gst', label: 'GST', accountId: 'out', amount: decimal(8) }],
      currency: 'MVR',
      baseCurrency: 'MVR',
      rate: decimal(1),
    });
    expect(sales.lines.map((l) => [l.role, l.accountId, l.side, l.amount.toFixed(2)])).toEqual([
      ['receivable', 'ar', 'debit', '108.00'],
      ['revenue', 'rev', 'credit', '100.00'],
      ['tax', 'out', 'credit', '8.00'],
    ]);
  });

  it('uses the effective-dated rate and the unchanged per-line calculation', () => {
    // TGST: 16% to 2025-06-30, 17% from 2025-07-01 (seeded); a purchase line uses the version in
    // effect on its date and the same rounding as Sales (Decisions 15, 33).
    const before = lineTax({
      amount: decimal(100),
      ratePercent: '16',
      treatment: 'exclusive',
      currency: 'MVR',
    });
    const after = lineTax({
      amount: decimal(100),
      ratePercent: '17',
      treatment: 'inclusive',
      currency: 'MVR',
    });
    expect(before.tax.toFixed(2)).toBe('16.00');
    expect(after.tax.toFixed(2)).toBe('14.53');
    expect(after.net.toFixed(2)).toBe('85.47');
  });
});

// ---------------------------------------------------------------------------
// Sales output tax regression
// ---------------------------------------------------------------------------

describe('Sales output tax is unchanged', () => {
  it('an issued invoice still credits the output tax account, never the input account', async () => {
    const org = await setUpAccountingOrg(ctx);
    const gst = (await codes(org)).find((c) => c.code === 'GST')!;
    expect(gst.inputTaxAccountId).toBe(org.accounts['1160']);
    const settings = await org.owner.put('/sales/settings', {
      version: 0,
      arAccountId: org.accounts['1130'],
      defaultRevenueAccountId: org.accounts['4100'],
      defaultDepositAccountId: org.accounts['1120'],
      defaultTaxCodeId: gst.id,
      defaultTaxTreatment: 'exclusive',
      defaultPaymentTermsDays: 30,
    });
    expect(settings.status).toBe(200);
    const customer = await org.owner.post('/customers', {
      party: { kind: 'organization', displayName: 'Reef Resort' },
    });
    const invoice = await org.owner.post('/sales/invoices', {
      customerId: customer.body.data.id,
      invoiceDate: '2026-03-10',
      lines: [{ description: 'Service', quantity: '1', unitPrice: '100' }],
    });
    expect(invoice.status, JSON.stringify(invoice.body)).toBe(201);
    const issued = await org.owner.post(`/sales/invoices/${invoice.body.data.id}/issue`, {
      version: invoice.body.data.version,
    });
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    const { rows } = await owner.query(
      `SELECT l.account_id, l.debit, l.credit
         FROM accounting_journal_lines l
         JOIN accounting_journal_entries j ON j.id = l.journal_id
        WHERE j.organization_id = $1 AND j.source_id = $2`,
      [org.organizationId, invoice.body.data.id],
    );
    const tax = rows.filter((r) => r.account_id === org.accounts['2130']);
    expect(tax).toHaveLength(1);
    expect(Number(tax[0].credit)).toBe(8);
    expect(rows.some((r) => r.account_id === org.accounts['1160'])).toBe(false);
  });
});
