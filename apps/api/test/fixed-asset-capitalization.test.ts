import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setUpAccountingOrg, type AccountingOrg } from './fixtures.js';
import { connectAs, createTestContext, MINUTE, type TestContext } from './helpers.js';

/**
 * Double-capitalization guard (migration 0051). A bill that debits an asset cost account has
 * already capitalized the purchase: the asset is registered as already in the ledger and linked to
 * the bill (checked and capped), and registering it with a posting acquisition next to a matching
 * bill is refused unless a reason confirms it is a different purchase.
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

interface AssetOrg extends AccountingOrg {
  categoryId: string;
  vendorId: string;
}

async function assetOrg(): Promise<AssetOrg> {
  const org = await setUpAccountingOrg(ctx);
  const purchases = await org.owner.put('/purchases/settings', {
    version: 0,
    apAccountId: org.accounts['2110'],
    defaultExpenseAccountId: org.accounts['5400'],
    defaultPaymentAccountId: org.accounts['1120'],
    defaultTaxCodeId: null,
    defaultTaxTreatment: 'exclusive',
    defaultPaymentTermsDays: 30,
  });
  expect(purchases.status, JSON.stringify(purchases.body)).toBe(200);
  const vendor = await org.owner.post('/vendors', {
    party: { kind: 'organization', displayName: 'Dive Gear Ltd' },
  });
  const category = await org.owner.post('/fixed-assets/categories', {
    name: 'Equipment',
    costAccountId: org.accounts['1510'],
    accumulatedAccountId: org.accounts['1520'],
    expenseAccountId: org.accounts['5500'],
    defaultLifeMonths: 60,
  });
  expect(category.status, JSON.stringify(category.body)).toBe(201);
  return { ...org, categoryId: category.body.data.id, vendorId: vendor.body.data.id };
}

async function capitalizingBill(
  o: AssetOrg,
  amount = '12000',
  billDate = '2026-01-15',
  accountId = o.accounts['1510'],
) {
  const created = await o.owner.post('/purchases/bills', {
    vendorId: o.vendorId,
    billDate,
    vendorReference: `SI-${randomUUID().slice(0, 8)}`,
    lines: [
      { description: 'Compressor', quantity: '1', unitPrice: amount, accountId, taxCodeId: null },
    ],
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const posted = await o.owner.post(`/purchases/bills/${created.body.data.id}/post`, {
    version: created.body.data.version,
  });
  expect(posted.status, JSON.stringify(posted.body)).toBe(200);
  return posted.body.data as { id: string; number: string; version: number };
}

const assetBody = (o: AssetOrg, overrides: Record<string, unknown> = {}) => ({
  name: 'Compressor',
  categoryId: o.categoryId,
  acquisitionDate: '2026-01-15',
  cost: '12000.00',
  lifeMonths: 60,
  ...overrides,
});

const linked = (o: AssetOrg, billId: string, overrides: Record<string, unknown> = {}) =>
  o.owner.post(
    '/fixed-assets/assets',
    assetBody(o, { alreadyInLedger: true, sourceBillId: billId, ...overrides }),
  );

async function costDifference(o: AssetOrg) {
  const report = (await o.owner.get('/fixed-assets/reports/reconciliation?asOf=2026-03-31')).body
    .data;
  return report.accounts.find((a: { kind: string }) => a.kind === 'cost').difference as string;
}

async function auditActions(o: AccountingOrg, resourceId: string) {
  const { rows } = await owner.query(
    `SELECT action FROM audit_events WHERE organization_id = $1 AND resource_id = $2 ORDER BY occurred_at, id`,
    [o.organizationId, resourceId],
  );
  return (rows as { action: string }[]).map((r) => r.action);
}

describe('linking an asset to the bill that capitalized it', () => {
  it('registers the asset against the bill without posting, so cost is in the ledger once', async () => {
    const o = await assetOrg();
    const bill = await capitalizingBill(o);
    const res = await linked(o, bill.id);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({
      sourceBillId: bill.id,
      acquisitionJournalId: null,
      inLedger: true,
    });
    expect(await costDifference(o)).toBe('0.00');
    expect(await auditActions(o, res.body.data.id)).toContain('fixed_asset.registered');
    // An asset already in the ledger without a link keeps working (historical behavior).
    const plain = await o.owner.post(
      '/fixed-assets/assets',
      assetBody(o, { name: 'Old asset', cost: '500.00', alreadyInLedger: true }),
    );
    expect(plain.status, JSON.stringify(plain.body)).toBe(201);
    expect(plain.body.data.sourceBillId).toBeNull();
  });

  it('refuses a link on an asset that would be posted again', async () => {
    const o = await assetOrg();
    const bill = await capitalizingBill(o);
    const res = await o.owner.post(
      '/fixed-assets/assets',
      assetBody(o, { sourceBillId: bill.id, creditAccountId: o.accounts['1120'] }),
    );
    expect(res.status).toBe(400);
    expect(res.body.error.details.issues[0].path).toBe('sourceBillId');
    expect((await o.owner.get('/fixed-assets/assets')).body.data.items).toHaveLength(0);
  });

  it('caps the linked cost at what the bill capitalized', async () => {
    const o = await assetOrg();
    const bill = await capitalizingBill(o, '12000');
    expect((await linked(o, bill.id, { cost: '7000.00' })).status).toBe(201);
    expect((await linked(o, bill.id, { cost: '5000.00', name: 'Second' })).status).toBe(201);
    const over = await linked(o, bill.id, { cost: '1.00', name: 'Third' });
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe('DUPLICATE_CAPITALIZATION');
    expect(over.body.error.message).toContain('only 0.00 is left');
    expect(await costDifference(o)).toBe('0.00');
  });

  it('needs a posted bill that debited the category asset account, in this organization', async () => {
    const o = await assetOrg();
    const expense = await capitalizingBill(o, '12000', '2026-01-15', o.accounts['5400']);
    expect((await linked(o, expense.id)).status).toBe(400);
    const draft = await o.owner.post('/purchases/bills', {
      vendorId: o.vendorId,
      billDate: '2026-01-15',
      vendorReference: 'D-1',
      lines: [
        {
          description: 'x',
          quantity: '1',
          unitPrice: '12000',
          accountId: o.accounts['1510'],
          taxCodeId: null,
        },
      ],
    });
    expect((await linked(o, draft.body.data.id)).status).toBe(400);
    expect((await linked(o, randomUUID())).status).toBe(400);
    const other = await assetOrg();
    const foreign = await capitalizingBill(other);
    expect((await linked(o, foreign.id)).status).toBe(400);
  });

  it('keeps the bill from being voided while assets are registered against it', async () => {
    const o = await assetOrg();
    const bill = await capitalizingBill(o);
    const asset = await linked(o, bill.id);
    ctx.clock.advance(16 * MINUTE);
    await o.owner.get('/auth/session');
    expect((await o.owner.reauthenticate()).status).toBe(200);
    const voided = await o.owner.post(`/purchases/bills/${bill.id}/void`, {
      version: bill.version,
      reason: 'Entered twice',
    });
    expect(voided.status).toBe(409);
    expect(voided.body.error.code).toBe('INVALID_STATE_TRANSITION');
    // The database refuses the same transition, and the link is immutable.
    await expect(
      owner.query(
        `UPDATE purchases_bills SET status = 'VOID', voided_at = now(), void_reason = 'x',
                void_journal_id = journal_id WHERE id = $1`,
        [bill.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      owner.query(`UPDATE fixed_assets SET source_bill_id = NULL WHERE id = $1`, [
        asset.body.data.id,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('registering an asset next to a matching bill', () => {
  it('refuses to post the acquisition again when a bill already capitalized it', async () => {
    const o = await assetOrg();
    const bill = await capitalizingBill(o);
    const res = await o.owner.post(
      '/fixed-assets/assets',
      assetBody(o, { creditAccountId: o.accounts['1120'] }),
    );
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DUPLICATE_CAPITALIZATION');
    expect(res.body.error.message).toContain(bill.number);
    expect((await o.owner.get('/fixed-assets/assets')).body.data.items).toHaveLength(0);
  });

  it('allows a different purchase: another amount, a distant date, or a confirming reason', async () => {
    const o = await assetOrg();
    await capitalizingBill(o);
    const credit = { creditAccountId: o.accounts['1120'] };
    const bigger = await o.owner.post(
      '/fixed-assets/assets',
      assetBody(o, { ...credit, cost: '13000.00' }),
    );
    expect(bigger.status, JSON.stringify(bigger.body)).toBe(201);
    const later = await o.owner.post(
      '/fixed-assets/assets',
      assetBody(o, { ...credit, acquisitionDate: '2026-03-20', name: 'Later' }),
    );
    expect(later.status, JSON.stringify(later.body)).toBe(201);
    const confirmed = await o.owner.post(
      '/fixed-assets/assets',
      assetBody(o, {
        ...credit,
        name: 'Second compressor',
        duplicateOverrideReason: 'A second unit bought for cash',
      }),
    );
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(201);
    expect(await auditActions(o, confirmed.body.data.id)).toContain(
      'fixed_asset.duplicate_capitalization_confirmed',
    );
    const tooShort = await o.owner.post(
      '/fixed-assets/assets',
      assetBody(o, { ...credit, duplicateOverrideReason: 'x' }),
    );
    expect(tooShort.status).toBe(400);
  });

  it('does not treat a bill already fully linked as a duplicate', async () => {
    const o = await assetOrg();
    const bill = await capitalizingBill(o);
    expect((await linked(o, bill.id)).status).toBe(201);
    const second = await o.owner.post(
      '/fixed-assets/assets',
      assetBody(o, { creditAccountId: o.accounts['1120'], name: 'Another' }),
    );
    expect(second.status, JSON.stringify(second.body)).toBe(201);
  });
});
