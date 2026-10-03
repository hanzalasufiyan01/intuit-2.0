import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inTransaction, setDbContext } from '../src/application/unit-of-work.js';
import { takeNextPurchaseNumber } from '../src/modules/purchases/index.js';
import { joinWithRole, line, setUpAccountingOrg, type AccountingOrg } from './fixtures.js';
import {
  connectAs,
  createTestContext,
  MINUTE,
  type TestClient,
  type TestContext,
} from './helpers.js';

/**
 * Phase 4A-5: bills (ADR 0004 P4-11, P4-12, P4-15 to P4-22, P4-37, P4-39, P4-42, P4-50, P4-51).
 * Drafts, conditional approval separate from Post, the AP journal through the accounting event
 * with recoverable input tax and capitalized non-recoverable tax, rates, duplicate supplier
 * references, numbering, voids through the Purchases reversal, evidence and security.
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

const PDF = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n');

interface PurchasesOrg extends AccountingOrg {
  gst: string;
  tgst: string;
  vendorId: string;
}

async function purchasesOrg(
  options: {
    vendor?: Record<string, unknown>;
    gstRegistered?: boolean;
    settings?: Record<string, unknown>;
  } = {},
): Promise<PurchasesOrg> {
  const org = await setUpAccountingOrg(ctx);
  const codes = (await org.owner.get('/tax/codes')).body.data as { id: string; code: string }[];
  const profile = await org.owner.put('/organizations/current/profile', {
    version:
      (await org.owner.get('/organizations/current/profile')).body.data.profile?.version ?? 0,
    legalName: 'Atoll Trading Pvt Ltd',
    gstRegistered: options.gstRegistered ?? true,
    gstRegisteredFrom: options.gstRegistered === false ? null : '2026-01-01',
    gstRegistrationNumber: options.gstRegistered === false ? null : '1000234GST501',
  });
  expect(profile.status, JSON.stringify(profile.body)).toBe(200);
  const settings = await org.owner.put('/purchases/settings', {
    version: 0,
    apAccountId: org.accounts['2110'],
    defaultExpenseAccountId: org.accounts['5400'],
    defaultPaymentAccountId: org.accounts['1120'],
    defaultTaxCodeId: null,
    defaultTaxTreatment: 'exclusive',
    defaultPaymentTermsDays: 30,
    ...options.settings,
  });
  expect(settings.status, JSON.stringify(settings.body)).toBe(200);
  const vendor = await org.owner.post('/vendors', {
    party: { kind: 'organization', displayName: 'Island Supplies' },
    ...options.vendor,
  });
  expect(vendor.status, JSON.stringify(vendor.body)).toBe(201);
  return {
    ...org,
    gst: codes.find((c) => c.code === 'GST')!.id,
    tgst: codes.find((c) => c.code === 'TGST')!.id,
    vendorId: vendor.body.data.id,
  };
}

const draft = (o: PurchasesOrg, overrides: Record<string, unknown> = {}) => ({
  vendorId: o.vendorId,
  billDate: '2026-03-10',
  vendorReference: `SI-${randomUUID().slice(0, 8)}`,
  lines: [{ description: 'Office supplies', quantity: '2', unitPrice: '50', taxCodeId: null }],
  ...overrides,
});

async function createBill(client: TestClient, body: object) {
  const res = await client.post('/purchases/bills', body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data;
}

async function post(client: TestClient, bill: { id: string; version: number }, extra = {}) {
  return client.post(`/purchases/bills/${bill.id}/post`, { version: bill.version, ...extra });
}

async function posted(client: TestClient, body: object) {
  const bill = await createBill(client, body);
  const res = await post(client, bill);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data;
}

async function journalOf(o: AccountingOrg, journalId: string) {
  return (await o.owner.get(`/accounting/journals/${journalId}`)).body.data as {
    status: string;
    currency: string;
    exchangeRate: string | null;
    exchangeRateSource: string | null;
    lines: {
      accountId: string;
      debit: string | null;
      credit: string | null;
      baseDebit: string | null;
      baseCredit: string | null;
      dimensions: { dimensionValueId: string }[];
    }[];
  };
}

/** The GL balance (base, debit − credit) of an account from posted journals. */
async function glBalance(organizationId: string, accountId: string) {
  const { rows } = await owner.query(
    `SELECT coalesce(sum(coalesce(l.base_debit, 0) - coalesce(l.base_credit, 0)), 0)::numeric(28,2)::text AS b
       FROM accounting_journal_lines l
       JOIN accounting_journal_entries j ON j.id = l.journal_id AND j.organization_id = l.organization_id
      WHERE l.organization_id = $1 AND l.account_id = $2 AND j.status IN ('POSTED', 'REVERSED')`,
    [organizationId, accountId],
  );
  return rows[0].b as string;
}

/** The AP subledger: open posted bills (base). */
async function apSubledger(organizationId: string) {
  const { rows } = await owner.query(
    `SELECT coalesce(sum(base_due), 0)::numeric(28,2)::text AS b FROM purchases_bills
      WHERE organization_id = $1 AND status = 'POSTED'`,
    [organizationId],
  );
  return rows[0].b as string;
}

async function auditActions(o: AccountingOrg, resourceId: string) {
  const { rows } = await owner.query(
    `SELECT action, metadata FROM audit_events WHERE organization_id = $1 AND resource_id = $2
      ORDER BY occurred_at, id`,
    [o.organizationId, resourceId],
  );
  return rows as { action: string; metadata: Record<string, unknown> }[];
}

async function createRole(client: TestClient, name: string, permissionKeys: string[]) {
  const res = await client.post('/organizations/current/roles', { name, permissionKeys });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

describe('bill drafts', () => {
  it('creates a draft with defaults from the vendor and Purchases settings', async () => {
    const o = await purchasesOrg({ vendor: { paymentTermsDays: 15 } });
    const bill = await createBill(
      o.owner,
      draft(o, {
        vendorReference: '  INV 2026/001  ',
        discount: { type: 'percent', value: '10' },
        lines: [
          { description: 'Paper', quantity: '2', unitPrice: '50', taxCodeId: o.gst },
          { description: 'Toner', quantity: '1', unitPrice: '100', taxCodeId: null },
        ],
      }),
    );
    expect(bill).toMatchObject({
      status: 'DRAFT',
      number: null,
      vendorName: 'Island Supplies',
      vendorReference: 'INV 2026/001',
      currencyCode: 'MVR',
      dueDate: '2026-03-25',
      paymentTermsDays: 15,
      taxTreatment: 'exclusive',
      subtotal: '200.00',
      discountTotal: '20.00',
      // Discounts come before tax: GST 8% on 90.00.
      taxTotal: '7.20',
      recoverableTaxTotal: '7.20',
      total: '187.20',
      version: 1,
    });
    expect(bill.lines[0]).toMatchObject({
      accountId: o.accounts['5400'],
      netAmount: '90.00',
      taxAmount: '7.20',
      taxRate: '8',
      taxRecoverable: true,
      taxRecoverableOverride: null,
      recoverableTax: '7.20',
      nonRecoverableTax: '0.00',
      inputTaxAccountId: null,
    });
    expect((await auditActions(o, bill.id)).map((a) => a.action)).toEqual(['bill.created']);
    // Drafts take no number.
    const { rows } = await owner.query(
      `SELECT next_number FROM purchases_number_sequences
        WHERE organization_id = $1 AND document_type = 'bill'`,
      [o.organizationId],
    );
    expect(Number(rows[0].next_number)).toBe(1);
  });

  it('keeps the supplier reference optional on drafts and edits under optimistic versions', async () => {
    const o = await purchasesOrg();
    const bill = await createBill(o.owner, draft(o, { vendorReference: null }));
    expect(bill.vendorReference).toBeNull();
    const updated = await o.owner.put(`/purchases/bills/${bill.id}`, {
      ...draft(o, { vendorReference: 'A-1' }),
      version: bill.version,
    });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body.data).toMatchObject({ vendorReference: 'A-1', version: 2 });
    const stale = await o.owner.put(`/purchases/bills/${bill.id}`, {
      ...draft(o),
      version: bill.version,
    });
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    expect((await auditActions(o, bill.id)).map((a) => a.action)).toEqual([
      'bill.created',
      'bill.updated',
    ]);
    // Draft deletion with the version; posted bills are voided instead.
    const deleted = await o.owner.delete(`/purchases/bills/${bill.id}?version=2`);
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    expect((await o.owner.get(`/purchases/bills/${bill.id}`)).status).toBe(404);
  });

  it('accepts active vendors only and never another organization’s', async () => {
    const o = await purchasesOrg();
    const other = await purchasesOrg();
    const foreign = await o.owner.post('/purchases/bills', draft(o, { vendorId: other.vendorId }));
    expect(foreign.status).toBe(400);
    expect(foreign.body.error.details.issues[0]).toEqual({
      path: 'vendorId',
      message: 'Vendor not found.',
    });
    const vendor = (await o.owner.get(`/vendors/${o.vendorId}`)).body.data;
    expect(
      (await o.owner.post(`/vendors/${o.vendorId}/archive`, { version: vendor.version })).status,
    ).toBe(200);
    const archived = await o.owner.post('/purchases/bills', draft(o));
    expect(archived.body.error.details.issues[0]).toEqual({
      path: 'vendorId',
      message: 'Archived vendors cannot get new bills.',
    });
  });

  it('applies P4-19 account eligibility and refuses sales-only items', async () => {
    const o = await purchasesOrg();
    const issuesFor = async (lineOverrides: object) => {
      const res = await o.owner.post(
        '/purchases/bills',
        draft(o, {
          lines: [{ description: 'x', quantity: '1', unitPrice: '10', ...lineOverrides }],
        }),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      return res.body.error.details.issues as { path: string; message: string }[];
    };
    expect(await issuesFor({ accountId: o.accounts['2110'] })).toContainEqual({
      path: 'lines.0.accountId',
      message: 'A control account cannot be used on purchases.',
    });
    expect((await issuesFor({ accountId: o.accounts['1120'] }))[0]!.path).toBe('lines.0.accountId');
    expect((await issuesFor({ accountId: o.accounts['4100'] }))[0]!.path).toBe('lines.0.accountId');
    expect((await issuesFor({ accountId: o.accounts['3100'] }))[0]!.path).toBe('lines.0.accountId');
    expect(await issuesFor({ accountId: o.accounts['5950'] })).toContainEqual({
      path: 'lines.0.accountId',
      message: 'A designated system account cannot be used on purchases.',
    });
    // Prepaid expenses through OTHER_CURRENT_ASSET and fixed assets are eligible.
    for (const code of ['1150', '1510']) {
      const ok = await o.owner.post(
        '/purchases/bills',
        draft(o, {
          lines: [
            { description: 'x', quantity: '1', unitPrice: '10', accountId: o.accounts[code] },
          ],
        }),
      );
      expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    }
    const soldOnly = await o.owner.post('/sales/items', {
      name: 'Consulting',
      itemType: 'service',
    });
    expect(await issuesFor({ itemId: soldOnly.body.data.id })).toContainEqual({
      path: 'lines.0.itemId',
      message: 'Consulting is not purchased.',
    });
    const strict = await o.owner.post('/purchases/bills', { ...draft(o), supplierInvoice: 'x' });
    expect(strict.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Tax and recoverability (P4-11, P4-12)
// ---------------------------------------------------------------------------

describe('bill tax and recoverability', () => {
  it('defaults from GST registration, then item, then vendor; overrides need bills.create', async () => {
    const o = await purchasesOrg({ vendor: { defaultTaxRecoverable: false } });
    const item = await o.owner.post('/sales/items', {
      name: 'Laptop',
      itemType: 'product',
      isSold: false,
      isPurchased: true,
      purchaseUnitCost: '1000',
      expenseAccountId: o.accounts['1510'],
      purchaseTaxCodeId: o.gst,
      purchaseTaxRecoverable: true,
    });
    expect(item.status, JSON.stringify(item.body)).toBe(201);
    const bill = await createBill(
      o.owner,
      draft(o, {
        lines: [
          // Item default (recoverable) beats the vendor default (not recoverable).
          { itemId: item.body.data.id, quantity: '1' },
          // No item: the vendor default applies.
          { description: 'Fuel', quantity: '1', unitPrice: '100', taxCodeId: o.gst },
          // Explicit override.
          {
            description: 'Meals',
            quantity: '1',
            unitPrice: '50',
            taxCodeId: o.gst,
            taxRecoverable: true,
          },
        ],
      }),
    );
    expect(
      bill.lines.map((l: Record<string, unknown>) => [
        l.description,
        l.accountId,
        l.unitPrice,
        l.taxRecoverable,
        l.taxRecoverableOverride,
        l.recoverableTax,
        l.nonRecoverableTax,
      ]),
    ).toEqual([
      ['Laptop', o.accounts['1510'], '1000', true, null, '80.00', '0.00'],
      ['Fuel', o.accounts['5400'], '100', false, null, '0.00', '8.00'],
      ['Meals', o.accounts['5400'], '50', true, true, '4.00', '0.00'],
    ]);
    expect(bill).toMatchObject({ taxTotal: '92.00', recoverableTaxTotal: '84.00' });

    // An explicit recoverability choice needs bills.create (an edit-only role cannot set it).
    await createRole(o.owner, 'Bill editor', ['bills.view', 'bills.edit_draft', 'vendors.view']);
    const editor = await joinWithRole(ctx, o.owner, 'Bill editor');
    const body = draft(o, {
      lines: [{ description: 'Fuel', quantity: '1', unitPrice: '100', taxCodeId: o.gst }],
    });
    const plain = await createBill(o.owner, body);
    const denied = await editor.client.put(`/purchases/bills/${plain.id}`, {
      ...body,
      version: plain.version,
      lines: [{ ...body.lines[0], taxRecoverable: true }],
    });
    expect(denied.status).toBe(403);
    const allowed = await editor.client.put(`/purchases/bills/${plain.id}`, {
      ...body,
      version: plain.version,
      memo: 'Edited',
    });
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
  });

  it('is not recoverable when the organization is not GST-registered on the bill date', async () => {
    const o = await purchasesOrg({ gstRegistered: false });
    const bill = await createBill(
      o.owner,
      draft(o, {
        lines: [{ description: 'Fuel', quantity: '1', unitPrice: '100', taxCodeId: o.gst }],
      }),
    );
    expect(bill.lines[0]).toMatchObject({
      taxRecoverable: false,
      recoverableTax: '0.00',
      nonRecoverableTax: '8.00',
    });
  });

  it('posts recoverable tax to the input account and capitalizes the rest; snapshots are frozen', async () => {
    const o = await purchasesOrg({ vendor: { defaultTaxRecoverable: false } });
    const bill = await posted(
      o.owner,
      draft(o, {
        lines: [
          {
            description: 'Stationery',
            quantity: '1',
            unitPrice: '100',
            taxCodeId: o.gst,
            taxRecoverable: true,
          },
          { description: 'Fuel', quantity: '1', unitPrice: '50', taxCodeId: o.gst },
          {
            description: 'Prepaid rent',
            quantity: '1',
            unitPrice: '300',
            taxCodeId: null,
            accountId: o.accounts['1150'],
          },
        ],
      }),
    );
    expect(bill).toMatchObject({
      status: 'POSTED',
      number: 'BILL-00001',
      total: '462.00',
      recoverableTaxTotal: '8.00',
      exchangeRateSource: 'base',
      baseTotal: '462.0000',
      amountDue: '462.00',
    });
    expect(
      bill.lines.map((l: { inputTaxAccountId: string | null }) => l.inputTaxAccountId),
    ).toEqual([o.accounts['1160'], o.accounts['1160'], null]);
    const journal = await journalOf(o, bill.journalId);
    const by = (id: string) => journal.lines.filter((l) => l.accountId === id);
    expect(by(o.accounts['2110']!).map((l) => [l.debit, l.credit])).toEqual([[null, '462.0000']]);
    expect(by(o.accounts['5400']!).map((l) => l.debit)).toEqual(['154.0000']);
    expect(by(o.accounts['1160']!).map((l) => l.debit)).toEqual(['8.0000']);
    expect(by(o.accounts['1150']!).map((l) => l.debit)).toEqual(['300.0000']);
    // Output tax is never touched by purchases.
    expect(by(o.accounts['2130']!)).toEqual([]);
    expect(await glBalance(o.organizationId, o.accounts['2110']!)).toBe('-462.00');
    expect(await apSubledger(o.organizationId)).toBe('462.00');
    // Posted lines are immutable at the database.
    await expect(
      owner.query(`UPDATE purchases_bill_lines SET tax_recoverable = false WHERE bill_id = $1`, [
        bill.id,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('blocks posting while a tax code has no input tax account (P4-11), with guidance', async () => {
    const o = await purchasesOrg();
    const gst = (await o.owner.get('/tax/codes')).body.data.find(
      (c: { code: string }) => c.code === 'GST',
    );
    expect(
      (
        await o.owner.patch(`/tax/codes/${gst.id}`, {
          version: gst.version,
          inputTaxAccountId: null,
        })
      ).status,
    ).toBe(200);
    const bill = await createBill(
      o.owner,
      draft(o, {
        lines: [{ description: 'Paper', quantity: '1', unitPrice: '10', taxCodeId: o.gst }],
      }),
    );
    expect(bill.warnings.map((w: { code: string }) => w.code)).toContain(
      'TAX_CODE_NOT_PURCHASABLE',
    );
    const res = await post(o.owner, bill);
    expect(res.status).toBe(400);
    expect(res.body.error.details.issues).toContainEqual({
      path: 'lines.0.taxCodeId',
      message:
        'GST has no input tax account. Set one under Tax codes before using it on purchases.',
    });
    expect((await o.owner.get(`/purchases/bills/${bill.id}`)).body.data.status).toBe('DRAFT');
  });

  it('uses the tax rate version in effect on the bill date', async () => {
    const o = await purchasesOrg();
    const before = await createBill(
      o.owner,
      draft(o, {
        billDate: '2025-06-30',
        lines: [{ description: 'Room', quantity: '1', unitPrice: '100', taxCodeId: o.tgst }],
      }),
    );
    const after = await createBill(
      o.owner,
      draft(o, {
        billDate: '2025-07-01',
        lines: [{ description: 'Room', quantity: '1', unitPrice: '100', taxCodeId: o.tgst }],
      }),
    );
    expect([before.lines[0].taxRate, after.lines[0].taxRate]).toEqual(['16', '17']);
  });
});

// ---------------------------------------------------------------------------
// Posting, numbering and AP
// ---------------------------------------------------------------------------

describe('posting bills', () => {
  it('posts through the accounting event with Purchases source, numbering and the AP lock', async () => {
    const o = await purchasesOrg();
    const bill = await posted(o.owner, draft(o));
    expect(bill).toMatchObject({ status: 'POSTED', number: 'BILL-00001', total: '100.00' });
    const { rows } = await owner.query(
      `SELECT j.status, j.source, j.source_module, j.source_type, j.source_id,
              e.event_type, e.source_module AS event_module
         FROM accounting_journal_entries j
         JOIN accounting_events e ON e.id = j.accounting_event_id
        WHERE j.id = $1`,
      [bill.journalId],
    );
    expect(rows[0]).toEqual({
      status: 'POSTED',
      source: 'event',
      source_module: 'purchases',
      source_type: 'bill',
      source_id: bill.id,
      event_type: 'purchases.bill_posted',
      event_module: 'purchases',
    });
    // The first post fixes the AP control account.
    const settings = (await o.owner.get('/purchases/settings')).body.data;
    expect(settings.apLocked).toBe(true);
    // Manual journals to AP stay refused, and the bill journal is reversed only through Purchases.
    const manual = await o.owner.post('/accounting/journals', {
      entryDate: '2026-03-15',
      description: 'Manual AP',
      currency: 'MVR',
      lines: [
        line(o.accounts['5400']!, 'debit', '10.00'),
        line(o.accounts['2110']!, 'credit', '10.00'),
      ],
    });
    expect(manual.status).toBe(400);
    const reverse = await o.owner.post(`/accounting/journals/${bill.journalId}/reverse`, {
      reason: 'Trying a manual reversal',
    });
    expect(reverse.status).toBe(409);
    // Posted bills are immutable (API and database).
    const edit = await o.owner.put(`/purchases/bills/${bill.id}`, {
      ...draft(o),
      version: bill.version,
    });
    expect(edit.body.error.code).toBe('INVALID_STATE_TRANSITION');
    await expect(
      owner.query(`UPDATE purchases_bills SET memo = 'x' WHERE id = $1`, [bill.id]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      owner.query(`DELETE FROM purchases_bills WHERE id = $1`, [bill.id]),
    ).rejects.toMatchObject({ code: '23514' });
    expect((await auditActions(o, bill.id)).map((a) => a.action)).toContain('bill.posted');
  });

  it('requires the supplier reference, the AP account and line accounts to post', async () => {
    const o = await purchasesOrg();
    const noRef = await createBill(o.owner, draft(o, { vendorReference: null }));
    const res = await post(o.owner, noRef);
    expect(res.status).toBe(400);
    expect(res.body.error.details.issues).toContainEqual({
      path: 'vendorReference',
      message: "Enter the supplier's invoice number before posting.",
    });
    const bare = await setUpAccountingOrg(ctx);
    const vendor = await bare.owner.post('/vendors', {
      party: { kind: 'organization', displayName: 'Nobody' },
    });
    const noSettings = await createBill(bare.owner, {
      vendorId: vendor.body.data.id,
      billDate: '2026-03-10',
      vendorReference: 'X-1',
      lines: [{ description: 'x', quantity: '1', unitPrice: '10' }],
    });
    const blocked = await post(bare.owner, noSettings);
    expect(blocked.body.error.details.issues.map((i: { path: string }) => i.path)).toEqual(
      expect.arrayContaining(['apAccountId', 'lines.0.accountId']),
    );
  });

  it('hands out distinct numbers to concurrent posts and never reuses one', async () => {
    const o = await purchasesOrg();
    const bills = [];
    for (let i = 0; i < 4; i += 1) bills.push(await createBill(o.owner, draft(o)));
    const results = await Promise.all(bills.map((b) => post(o.owner, b)));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(new Set(results.map((r) => r.body.data.number)).size).toBe(4);
    // A number taken by a rolled-back posting leaves a gap (R37); Sales numbering is untouched.
    const who = {
      organizationId: o.organizationId,
      userId: (await o.owner.get('/auth/session')).body.data.user.id as string,
    };
    await inTransaction(ctx.database.db, who, async (tx) => {
      await setDbContext(tx, who);
      return takeNextPurchaseNumber(tx, o.organizationId, 'bill');
    });
    const next = await posted(o.owner, draft(o));
    expect(next.number).toBe('BILL-00006');
  });

  it('is retry-safe: the same idempotency key posts once', async () => {
    const o = await purchasesOrg();
    const key = randomUUID();
    const body = draft(o);
    const create = await o.owner.post('/purchases/bills', body, { 'idempotency-key': key });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    // A retry with the same key and request returns the first bill; another request is refused.
    const repeat = await o.owner.post('/purchases/bills', body, { 'idempotency-key': key });
    expect(repeat.status).toBe(201);
    expect(repeat.body.data.id).toBe(create.body.data.id);
    const other = await o.owner.post(
      '/purchases/bills',
      { ...body, memo: 'changed' },
      {
        'idempotency-key': key,
      },
    );
    expect(other.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    const { rows: drafts } = await owner.query(
      `SELECT count(*)::int AS n FROM purchases_bills WHERE organization_id = $1`,
      [o.organizationId],
    );
    expect(drafts[0].n).toBe(1);
    const bill = create.body.data;
    const postKey = randomUUID();
    const first = await o.owner.post(
      `/purchases/bills/${bill.id}/post`,
      { version: bill.version },
      { 'idempotency-key': postKey },
    );
    const second = await o.owner.post(
      `/purchases/bills/${bill.id}/post`,
      { version: bill.version },
      { 'idempotency-key': postKey },
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.data.journalId).toBe(first.body.data.journalId);
    const { rows } = await owner.query(
      `SELECT count(*)::int AS n FROM accounting_events
        WHERE organization_id = $1 AND event_type = 'purchases.bill_posted' AND event_key = $2`,
      [o.organizationId, `bill:${bill.id}:posted`],
    );
    expect(rows[0].n).toBe(1);
    // Without a key, a second post of the same bill is refused (not posted twice).
    const twice = await post(o.owner, bill);
    expect(twice.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// Duplicate supplier references (P4-17, P4-18)
// ---------------------------------------------------------------------------

describe('duplicate supplier references', () => {
  it('blocks a duplicate (case and spaces ignored) unless confirmed with an audited reason', async () => {
    const o = await purchasesOrg();
    const first = await posted(o.owner, draft(o, { vendorReference: 'INV-778' }));
    const second = await createBill(
      o.owner,
      draft(o, {
        vendorReference: ' inv- 778',
        lines: [{ description: 'Other', quantity: '1', unitPrice: '75', taxCodeId: null }],
      }),
    );
    expect(second.warnings.map((w: { code: string }) => w.code)).toContain(
      'DUPLICATE_VENDOR_REFERENCE',
    );
    const blocked = await post(o.owner, second);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('DUPLICATE_VENDOR_REFERENCE');
    expect(blocked.body.error.details.issues[0].message).toContain('BILL-00001');
    // The failed attempt took no number.
    const confirmed = await post(o.owner, second, {
      duplicateReason: 'Supplier reissued the invoice for a second delivery.',
    });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect(confirmed.body.data).toMatchObject({
      number: 'BILL-00002',
      vendorReference: 'inv- 778',
      duplicateConfirmedReason: 'Supplier reissued the invoice for a second delivery.',
    });
    const audit = await auditActions(o, second.id);
    expect(audit.find((a) => a.action === 'bill.duplicate_confirmed')?.metadata).toMatchObject({
      reason: 'Supplier reissued the invoice for a second delivery.',
      duplicateBillIds: [first.id],
    });
    // Another vendor may use the same reference freely.
    const vendor2 = await o.owner.post('/vendors', {
      party: { kind: 'organization', displayName: 'Other Supplier' },
    });
    const free = await posted(
      o.owner,
      draft(o, { vendorId: vendor2.body.data.id, vendorReference: 'INV-778' }),
    );
    expect(free.status).toBe('POSTED');
    // Voided bills do not count.
    const voidable = await posted(o.owner, draft(o, { vendorReference: 'VOID-1' }));
    expect(
      (
        await o.owner.post(`/purchases/bills/${voidable.id}/void`, {
          version: voidable.version,
          reason: 'Entered twice',
        })
      ).status,
    ).toBe(200);
    expect((await posted(o.owner, draft(o, { vendorReference: 'void-1' }))).status).toBe('POSTED');
  });

  it('warns, without blocking, about the same total within 7 days', async () => {
    const o = await purchasesOrg();
    await posted(o.owner, draft(o, { billDate: '2026-03-05' }));
    const near = await createBill(o.owner, draft(o, { billDate: '2026-03-11' }));
    expect(near.warnings.map((w: { code: string }) => w.code)).toEqual(['POSSIBLE_DUPLICATE']);
    const far = await createBill(o.owner, draft(o, { billDate: '2026-03-20' }));
    expect(far.warnings).toEqual([]);
    expect((await post(o.owner, near)).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Currency and rates (P4-16, P4-20)
// ---------------------------------------------------------------------------

describe('bill currency and rates', () => {
  it('defaults to the vendor currency and fixes the table rate at post', async () => {
    const o = await purchasesOrg({ vendor: { currencyCode: 'USD' } });
    const bill = await createBill(
      o.owner,
      draft(o, { lines: [{ description: 'Engine part', quantity: '1', unitPrice: '1000' }] }),
    );
    expect(bill.currencyCode).toBe('USD');
    const missing = await post(o.owner, bill);
    expect(missing.body.error.code).toBe('EXCHANGE_RATE_REQUIRED');
    await o.owner.post('/accounting/exchange-rates', {
      fromCurrency: 'USD',
      rateDate: '2026-03-01',
      rate: '15.42',
    });
    const res = await post(o.owner, (await o.owner.get(`/purchases/bills/${bill.id}`)).body.data);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({
      number: 'BILL-00001',
      exchangeRate: '15.4200000000',
      exchangeRateSource: 'table',
      tableRate: '15.4200000000',
      baseTotal: '15420.0000',
    });
    const journal = await journalOf(o, res.body.data.journalId);
    expect(journal).toMatchObject({ currency: 'USD', exchangeRateSource: 'table' });
    const base = journal.lines.reduce(
      (s, l) => s + Number(l.baseDebit ?? 0) - Number(l.baseCredit ?? 0),
      0,
    );
    expect(base).toBe(0);
    expect(await glBalance(o.organizationId, o.accounts['2110']!)).toBe('-15420.00');
    expect(await apSubledger(o.organizationId)).toBe('15420.00');
  });

  it('accepts a manual rate with a reason from bills.post holders, keeping the table rate', async () => {
    const o = await purchasesOrg({ vendor: { currencyCode: 'USD' } });
    await o.owner.post('/accounting/exchange-rates', {
      fromCurrency: 'USD',
      rateDate: '2026-03-01',
      rate: '15.42',
    });
    const noReason = await o.owner.post(
      '/purchases/bills',
      draft(o, {
        rateOverride: '15.50',
        lines: [{ description: 'x', quantity: '1', unitPrice: '100' }],
      }),
    );
    expect(noReason.body.error.details.issues).toContainEqual({
      path: 'rateOverrideReason',
      message: 'Give a reason for the manual exchange rate.',
    });
    await createRole(o.owner, 'Bill clerk', ['bills.view', 'bills.create', 'vendors.view']);
    const clerk = await joinWithRole(ctx, o.owner, 'Bill clerk');
    const body = draft(o, {
      rateOverride: '15.50',
      rateOverrideReason: 'Rate on the supplier invoice (bank remittance)',
      lines: [{ description: 'Spare part', quantity: '1', unitPrice: '100' }],
    });
    expect((await clerk.client.post('/purchases/bills', body)).status).toBe(403);
    const bill = await posted(o.owner, body);
    expect(bill).toMatchObject({
      exchangeRate: '15.5000000000',
      exchangeRateSource: 'manual',
      tableRate: '15.4200000000',
      rateOverrideReason: 'Rate on the supplier invoice (bank remittance)',
      baseTotal: '1550.0000',
    });
    const journal = await journalOf(o, bill.journalId);
    expect(journal).toMatchObject({ exchangeRateSource: 'manual', exchangeRate: '15.5000000000' });
    expect(
      (await auditActions(o, bill.id)).find((a) => a.action === 'bill.rate_overridden')?.metadata,
    ).toMatchObject({ rate: '15.5000000000', tableRate: '15.4200000000' });
    // A base-currency bill has no rate to override.
    const base = await purchasesOrg();
    const refused = await base.owner.post(
      '/purchases/bills',
      draft(base, { rateOverride: '1.1', rateOverrideReason: 'x' }),
    );
    expect(refused.body.error.details.issues[0].path).toBe('rateOverride');
  });
});

// ---------------------------------------------------------------------------
// Approval (P4-15, P4-37)
// ---------------------------------------------------------------------------

describe('bill approval', () => {
  async function withPolicy(threshold: string) {
    const o = await purchasesOrg();
    const roles = (await o.owner.get('/organizations/current/roles')).body.data as {
      id: string;
      name: string;
    }[];
    const adminRole = roles.find((r) => r.name === 'Administrator')!.id;
    const policy = await o.owner.put('/approvals/policies/purchases.bill.post', {
      steps: [
        {
          name: 'Purchasing manager',
          requiredApprovals: 1,
          roleIds: [adminRole],
          membershipIds: [],
          conditions: { minBaseAmount: threshold },
        },
      ],
    });
    expect(policy.status, JSON.stringify(policy.body)).toBe(200);
    const admin = await joinWithRole(ctx, o.owner, 'Administrator');
    return { o, admin: admin.client };
  }

  it('posts below the threshold directly; above it, approval authorizes and Post is separate', async () => {
    const { o, admin } = await withPolicy('500');
    const small = await posted(o.owner, draft(o));
    expect(small.status).toBe('POSTED');
    const large = await createBill(
      o.owner,
      draft(o, { lines: [{ description: 'Generator', quantity: '1', unitPrice: '800' }] }),
    );
    expect(large.approval).toMatchObject({ required: true, readyToIssue: false });
    const direct = await post(o.owner, large);
    expect(direct.body.error.code).toBe('APPROVAL_REQUIRED');
    const submitted = await o.owner.post(`/purchases/bills/${large.id}/submit`, {
      version: large.version,
    });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    expect(submitted.body.data.status).toBe('PENDING_APPROVAL');
    const again = await o.owner.post(`/purchases/bills/${large.id}/submit`, {
      version: submitted.body.data.version,
    });
    expect(again.body.error.code).toBe('INVALID_STATE_TRANSITION');
    // Editing while pending is refused.
    const edit = await o.owner.put(`/purchases/bills/${large.id}`, {
      ...draft(o),
      version: submitted.body.data.version,
    });
    expect(edit.body.error.code).toBe('INVALID_STATE_TRANSITION');
    const requestId = submitted.body.data.approval.requestId;
    expect(
      (await o.owner.post(`/approvals/requests/${requestId}/approve`, {})).body.error.code,
    ).toBe('SELF_APPROVAL_PROHIBITED');
    const approved = await admin.post(`/approvals/requests/${requestId}/approve`, {});
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    // Approval did not post.
    const after = (await o.owner.get(`/purchases/bills/${large.id}`)).body.data;
    expect(after).toMatchObject({ status: 'PENDING_APPROVAL', number: null });
    expect(after.approval).toMatchObject({ readyToIssue: true, requestStatus: 'approved' });
    expect(after.approval.appliedSteps).toEqual([
      expect.objectContaining({
        name: 'Purchasing manager',
        conditions: expect.objectContaining({ minBaseAmount: '500' }),
      }),
    ]);
    // Policy edits do not change the existing request's snapshot.
    await o.owner.put('/approvals/policies/purchases.bill.post', {
      steps: [
        {
          name: 'Renamed step',
          requiredApprovals: 1,
          roleIds: [],
          membershipIds: [],
          conditions: { minBaseAmount: '500' },
        },
      ],
    });
    const done = await post(o.owner, after);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.data.status).toBe('POSTED');
    expect((await auditActions(o, large.id)).map((a) => a.action)).toEqual(
      expect.arrayContaining(['bill.submitted', 'bill.approved', 'bill.posted']),
    );
  });

  it('needs a reason to reject, returns the bill to draft, and supports withdrawal', async () => {
    const { o, admin } = await withPolicy('0');
    const bill = await createBill(o.owner, draft(o));
    const submitted = (
      await o.owner.post(`/purchases/bills/${bill.id}/submit`, { version: bill.version })
    ).body.data;
    const requestId = submitted.approval.requestId;
    const noReason = await admin.post(`/approvals/requests/${requestId}/reject`, {});
    expect(noReason.status).toBe(400);
    expect(noReason.body.error.details.issues[0].path).toBe('comment');
    expect((await o.owner.get(`/purchases/bills/${bill.id}`)).body.data.status).toBe(
      'PENDING_APPROVAL',
    );
    const rejected = await admin.post(`/approvals/requests/${requestId}/reject`, {
      comment: 'Wrong vendor',
    });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    const back = (await o.owner.get(`/purchases/bills/${bill.id}`)).body.data;
    expect(back.status).toBe('DRAFT');
    const reSubmitted = (
      await o.owner.post(`/purchases/bills/${bill.id}/submit`, { version: back.version })
    ).body.data;
    const withdrawn = await o.owner.post(`/purchases/bills/${bill.id}/withdraw`, {
      version: reSubmitted.version,
    });
    expect(withdrawn.status, JSON.stringify(withdrawn.body)).toBe(200);
    expect(withdrawn.body.data.status).toBe('DRAFT');
    expect((await auditActions(o, bill.id)).map((a) => a.action)).toEqual(
      expect.arrayContaining(['bill.rejected', 'bill.withdrawn']),
    );
    // With no matching step, submitting is refused: post directly.
    const plain = await purchasesOrg();
    const direct = await createBill(plain.owner, draft(plain));
    const refused = await plain.owner.post(`/purchases/bills/${direct.id}/submit`, {
      version: direct.version,
    });
    expect(refused.body.error.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('refuses a stale post after approval and lets only one of two racing posts win', async () => {
    const { o, admin } = await withPolicy('0');
    const bill = await createBill(o.owner, draft(o));
    const submitted = (
      await o.owner.post(`/purchases/bills/${bill.id}/submit`, { version: bill.version })
    ).body.data;
    await admin.post(`/approvals/requests/${submitted.approval.requestId}/approve`, {});
    const fresh = (await o.owner.get(`/purchases/bills/${bill.id}`)).body.data;
    const results = await Promise.all([post(o.owner, fresh), post(admin, fresh)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const { rows } = await owner.query(
      `SELECT count(*)::int AS n FROM accounting_journal_entries WHERE source_id = $1`,
      [bill.id],
    );
    expect(rows[0].n).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Dimensions (D10)
// ---------------------------------------------------------------------------

describe('bill dimensions', () => {
  it('enforces required dimensions at submit and post, rejects invalid values, keeps posted values', async () => {
    const o = await purchasesOrg();
    const type = await o.owner.post('/accounting/dimensions', {
      code: 'DEPT',
      name: 'Department',
      isRequired: true,
      scope: { accountTypes: ['EXPENSE'], accountSubtypes: [] },
    });
    expect(type.status, JSON.stringify(type.body)).toBe(201);
    const value = await o.owner.post(`/accounting/dimensions/${type.body.data.id}/values`, {
      code: 'OPS',
      name: 'Operations',
    });
    const missing = await post(o.owner, await createBill(o.owner, draft(o)));
    expect(missing.status).toBe(400);
    expect(missing.body.error.message).toBe('Required dimensions are missing.');
    expect(missing.body.error.details.issues).toEqual([
      { path: 'lines', message: 'Department is required for expense lines.' },
    ]);
    const unknown = await o.owner.post(
      '/purchases/bills',
      draft(o, { dimensionValueIds: [randomUUID()] }),
    );
    expect(unknown.body.error.details.issues[0]).toEqual({
      path: 'dimensionValueIds',
      message: 'Unknown dimension value.',
    });
    const tagged = await posted(o.owner, draft(o, { dimensionValueIds: [value.body.data.id] }));
    const journal = await journalOf(o, tagged.journalId);
    const expense = journal.lines.find((l) => l.accountId === o.accounts['5400'])!;
    expect(expense.dimensions.map((d) => d.dimensionValueId)).toEqual([value.body.data.id]);
    expect(tagged.dimensionValueIds).toEqual([value.body.data.id]);
    // Posted assignments are immutable at the database.
    await expect(
      owner.query(`UPDATE purchases_bills SET dimension_value_ids = '{}' WHERE id = $1`, [
        tagged.id,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      owner.query(`UPDATE purchases_bill_lines SET dimension_value_ids = '{}' WHERE bill_id = $1`, [
        tagged.id,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

// ---------------------------------------------------------------------------
// Void (P4-21)
// ---------------------------------------------------------------------------

describe('voiding bills', () => {
  it('reverses through Purchases with re-authentication, and refuses closed periods and repeats', async () => {
    const o = await purchasesOrg();
    const bill = await posted(o.owner, draft(o));
    ctx.clock.advance(16 * MINUTE);
    await o.owner.get('/auth/session');
    const stale = await o.owner.post(`/purchases/bills/${bill.id}/void`, {
      version: bill.version,
      reason: 'Duplicate entry',
    });
    expect(stale.body.error.code).toBe('REAUTHENTICATION_REQUIRED');
    expect((await o.owner.reauthenticate()).status).toBe(200);
    const voided = await o.owner.post(`/purchases/bills/${bill.id}/void`, {
      version: bill.version,
      reason: 'Duplicate entry',
    });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect(voided.body.data).toMatchObject({ status: 'VOID', amountDue: '0.00' });
    const original = await journalOf(o, bill.journalId);
    expect(original.status).toBe('REVERSED');
    expect(await glBalance(o.organizationId, o.accounts['2110']!)).toBe('0.00');
    expect(await apSubledger(o.organizationId)).toBe('0.00');
    const again = await o.owner.post(`/purchases/bills/${bill.id}/void`, {
      version: voided.body.data.version,
      reason: 'Again',
    });
    expect(again.body.error.code).toBe('INVALID_STATE_TRANSITION');

    const closedOrg = await purchasesOrg();
    const march = await posted(closedOrg.owner, draft(closedOrg));
    const period = closedOrg.periods.find((p) => p.startDate === '2026-03-01')!;
    expect((await closedOrg.owner.post(`/accounting/periods/${period.id}/close`)).status).toBe(200);
    const closed = await closedOrg.owner.post(`/purchases/bills/${march.id}/void`, {
      version: march.version,
      reason: 'Too late',
    });
    expect(closed.body.error.code).toBe('PERIOD_CLOSED');
    expect((await closedOrg.owner.get(`/purchases/bills/${march.id}`)).body.data.status).toBe(
      'POSTED',
    );
  });

  it('cannot void a paid bill (database guard; payments are a later stage)', async () => {
    const o = await purchasesOrg();
    const bill = await posted(o.owner, draft(o));
    // Simulate a part payment (the payments stage will reduce the open balance this way).
    await owner.query(
      `UPDATE purchases_bills SET amount_due = total - 10, base_due = base_total - 10 WHERE id = $1`,
      [bill.id],
    );
    const fresh = (await o.owner.get(`/purchases/bills/${bill.id}`)).body.data;
    const refused = await o.owner.post(`/purchases/bills/${bill.id}/void`, {
      version: fresh.version,
      reason: 'Paid already',
    });
    expect(refused.body.error.code).toBe('INVALID_STATE_TRANSITION');
    await expect(
      owner.query(
        `UPDATE purchases_bills SET status = 'VOID', voided_at = now(), void_reason = 'x',
                void_journal_id = journal_id, amount_due = 0, base_due = 0
          WHERE id = $1`,
        [bill.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

// ---------------------------------------------------------------------------
// Evidence (P4-22)
// ---------------------------------------------------------------------------

describe('bill evidence', () => {
  it('adds evidence at any time and removes it only while the bill is a draft', async () => {
    const o = await purchasesOrg();
    const bill = await createBill(o.owner, draft(o));
    const first = await o.owner.upload(`/files?linkType=bill&linkId=${bill.id}`, PDF, 'inv.pdf');
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect((await o.owner.delete(`/files/${first.body.data.id}`)).status).toBe(204);
    const kept = await o.owner.upload(`/files?linkType=bill&linkId=${bill.id}`, PDF, 'inv.pdf');
    const done = await post(o.owner, (await o.owner.get(`/purchases/bills/${bill.id}`)).body.data);
    expect(done.status).toBe(200);
    const late = await o.owner.upload(`/files?linkType=bill&linkId=${bill.id}`, PDF, 'late.pdf');
    expect(late.status).toBe(201);
    const remove = await o.owner.delete(`/files/${kept.body.data.id}`);
    expect(remove.status).toBe(409);
    const member = await joinWithRole(ctx, o.owner, 'Member');
    const listed = await member.client.get(`/files?linkType=bill&linkId=${bill.id}`);
    expect(listed.status).toBe(200);
    expect(
      (await member.client.upload(`/files?linkType=bill&linkId=${bill.id}`, PDF, 'x.pdf')).status,
    ).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

describe('bill security', () => {
  it('follows the bill permission catalog for each action', async () => {
    const o = await purchasesOrg();
    const member = await joinWithRole(ctx, o.owner, 'Member');
    const bill = await createBill(o.owner, draft(o));
    // Member: view only (P4-40).
    expect((await member.client.get('/purchases/bills')).status).toBe(200);
    expect((await member.client.get(`/purchases/bills/${bill.id}`)).status).toBe(200);
    expect((await member.client.post('/purchases/bills', draft(o))).status).toBe(403);
    expect((await post(member.client, bill)).status).toBe(403);
    expect(
      (await member.client.post(`/purchases/bills/${bill.id}/submit`, { version: 1 })).status,
    ).toBe(403);
    await createRole(o.owner, 'Bill creator', ['bills.view', 'bills.create', 'vendors.view']);
    const creator = await joinWithRole(ctx, o.owner, 'Bill creator');
    const own = await createBill(creator.client, draft(o));
    expect((await post(creator.client, own)).status).toBe(403);
    expect((await creator.client.delete(`/purchases/bills/${own.id}?version=1`)).status).toBe(403);
    const vendorsOnly = await joinWithRole(ctx, o.owner, 'Member');
    await owner.query(
      `DELETE FROM role_permissions WHERE role_id = $1 AND permission_key = 'bills.view'`,
      [vendorsOnly.roleId],
    );
    expect((await vendorsOnly.client.get('/purchases/bills')).status).toBe(403);
  });

  it('keeps bills tenant-isolated (API and RLS)', async () => {
    const a = await purchasesOrg();
    const b = await purchasesOrg();
    const bill = await createBill(a.owner, draft(a));
    expect((await b.owner.get(`/purchases/bills/${bill.id}`)).status).toBe(404);
    expect((await post(b.owner, bill)).status).toBe(404);
    expect((await b.owner.get('/purchases/bills')).body.data.items).toEqual([]);
    const app = await connectAs('app');
    try {
      await app.query('BEGIN');
      await app.query(`SELECT set_config('app.organization_id', $1, true)`, [b.organizationId]);
      expect((await app.query(`SELECT id FROM purchases_bills`)).rows).toEqual([]);
      expect((await app.query(`SELECT id FROM purchases_bill_lines`)).rows).toEqual([]);
    } finally {
      await app.query('ROLLBACK');
      await app.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Template permissions
// ---------------------------------------------------------------------------

describe('bill permissions in role templates', () => {
  it('gives Administrators every bill key and Members bills.view', async () => {
    const o = await setUpAccountingOrg(ctx);
    const { rows } = await owner.query(
      `SELECT r.name, array_agg(rp.permission_key ORDER BY rp.permission_key) AS keys
         FROM roles r JOIN role_permissions rp ON rp.role_id = r.id
        WHERE r.organization_id = $1 AND rp.permission_key LIKE 'bills.%'
        GROUP BY r.name ORDER BY r.name`,
      [o.organizationId],
    );
    const all = [
      'bills.approve',
      'bills.create',
      'bills.delete_draft',
      'bills.edit_draft',
      'bills.post',
      'bills.view',
      'bills.void',
    ];
    expect(rows).toEqual([
      { name: 'Administrator', keys: all },
      { name: 'Member', keys: ['bills.view'] },
      { name: 'Owner', keys: all },
    ]);
  });
});
