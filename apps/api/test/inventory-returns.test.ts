import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { joinWithRole, setUpAccountingOrg, type AccountingOrg } from './fixtures.js';
import { connectAs, createTestContext, type TestContext } from './helpers.js';

/**
 * Customer returns (master context section 18, ADR 0006 deviation, ADR 0012): goods that come
 * back against an issued credit note return to stock at the cost they left it, post Dr inventory /
 * Cr cost of goods sold, and can be voided. Real PostgreSQL; the stock ledger is checked against
 * the general ledger.
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

interface StockOrg extends AccountingOrg {
  vendorId: string;
  customerId: string;
  itemId: string;
}

async function stockOrg(): Promise<StockOrg> {
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
  const sales = await org.owner.put('/sales/settings', {
    version: 0,
    arAccountId: org.accounts['1130'],
    defaultRevenueAccountId: org.accounts['4100'],
    defaultDepositAccountId: org.accounts['1120'],
    defaultTaxCodeId: null,
    defaultTaxTreatment: 'exclusive',
    defaultPaymentTermsDays: 30,
  });
  expect(sales.status, JSON.stringify(sales.body)).toBe(200);
  const vendor = await org.owner.post('/vendors', {
    party: { kind: 'organization', displayName: 'Island Wholesale' },
  });
  const customer = await org.owner.post('/customers', {
    party: { kind: 'organization', displayName: 'Sun Island Resort' },
  });
  const item = await org.owner.post('/sales/items', {
    name: 'Coconut oil 1L',
    itemType: 'product',
    unitPrice: '60',
    revenueAccountId: org.accounts['4100'],
  });
  expect(item.status, JSON.stringify(item.body)).toBe(201);
  const tracked = await org.owner.post(`/inventory/items/${item.body.data.id}`, {
    inventoryAccountId: org.accounts['1140'],
    cogsAccountId: org.accounts['5100'],
  });
  expect(tracked.status, JSON.stringify(tracked.body)).toBe(201);
  return {
    ...org,
    vendorId: vendor.body.data.id,
    customerId: customer.body.data.id,
    itemId: item.body.data.id,
  };
}

/** Buys `quantity` at `unitPrice`. */
async function buy(o: StockOrg, quantity: string, unitPrice: string) {
  const draft = await o.owner.post('/purchases/bills', {
    vendorId: o.vendorId,
    billDate: '2026-03-10',
    vendorReference: `SI-${randomUUID().slice(0, 8)}`,
    lines: [{ itemId: o.itemId, description: 'Oil', quantity, unitPrice, taxCodeId: null }],
  });
  expect(draft.status, JSON.stringify(draft.body)).toBe(201);
  const posted = await o.owner.post(`/purchases/bills/${draft.body.data.id}/post`, {
    version: draft.body.data.version,
  });
  expect(posted.status, JSON.stringify(posted.body)).toBe(200);
}

/** Sells `quantity` at 60 and returns the issued invoice. */
async function sell(o: StockOrg, quantity: string) {
  const draft = await o.owner.post('/sales/invoices', {
    customerId: o.customerId,
    invoiceDate: '2026-03-15',
    lines: [{ itemId: o.itemId, description: 'Oil', quantity, unitPrice: '60', taxCodeId: null }],
  });
  expect(draft.status, JSON.stringify(draft.body)).toBe(201);
  const issued = await o.owner.post(`/sales/invoices/${draft.body.data.id}/issue`, {
    version: draft.body.data.version,
  });
  expect(issued.status, JSON.stringify(issued.body)).toBe(200);
  return issued.body.data;
}

/** A credit note for `quantity` of the item, issued; linked to the invoice when one is given. */
async function credit(
  o: StockOrg,
  quantity: string,
  invoiceId: string | null = null,
  draftOnly = false,
) {
  const draft = await o.owner.post('/sales/credit-notes', {
    customerId: o.customerId,
    creditDate: '2026-03-20',
    ...(invoiceId ? { invoiceId } : {}),
    lines: [
      { itemId: o.itemId, description: 'Oil returned', quantity, unitPrice: '60', taxCodeId: null },
    ],
  });
  expect(draft.status, JSON.stringify(draft.body)).toBe(201);
  if (draftOnly) return draft.body.data;
  const issued = await o.owner.post(`/sales/credit-notes/${draft.body.data.id}/issue`, {
    version: draft.body.data.version,
  });
  expect(issued.status, JSON.stringify(issued.body)).toBe(200);
  return issued.body.data;
}

const stock = async (o: StockOrg) =>
  (await o.owner.get(`/inventory/items/${o.itemId}`)).body.data as {
    quantity: string;
    averageCost: string;
    value: string;
  };

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

const post = (o: StockOrg, body: object) => o.owner.post('/inventory/returns', body);
const returnBody = (o: StockOrg, creditNoteId: string, quantity: string, extra = {}) => ({
  returnDate: '2026-03-22',
  creditNoteId,
  reason: 'Customer sent the goods back',
  lines: [{ itemId: o.itemId, quantity }],
  ...extra,
});

describe('customer returns', () => {
  it('puts the goods back at the cost they left, posts Dr inventory / Cr cost of goods sold, and keeps stock equal to the ledger', async () => {
    const o = await stockOrg();
    await buy(o, '10', '12'); // 10 for 120 -> 12 each
    const invoice = await sell(o, '4'); // sells 4 at 12 = COGS 48; 6 left (value 72)
    const note = await credit(o, '3', invoice.id);
    expect(await stock(o)).toMatchObject({ quantity: '6', value: '72.0000' });
    expect(await glBalance(o.organizationId, o.accounts['1140']!)).toBe('72.00');
    expect(await glBalance(o.organizationId, o.accounts['5100']!)).toBe('48.00');

    const res = await post(o, returnBody(o, note.id, '2'));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({
      status: 'POSTED',
      creditNoteId: note.id,
      totalValue: '24.0000',
      lines: [{ itemId: o.itemId, quantity: '2', unitCost: '12', value: '24.0000' }],
    });
    expect(res.body.data.number).toMatch(/^RET-\d{5}$/);
    // Stock 8 at 96; inventory +24, cost of goods sold -24: the ledger agrees with the stock ledger.
    expect(await stock(o)).toMatchObject({ quantity: '8', value: '96.0000' });
    expect(await glBalance(o.organizationId, o.accounts['1140']!)).toBe('96.00');
    expect(await glBalance(o.organizationId, o.accounts['5100']!)).toBe('24.00');
    const journal = (await o.owner.get(`/accounting/journals/${res.body.data.journalId}`)).body
      .data;
    expect(journal.status).toBe('POSTED');
    expect(
      journal.lines.map((l: { accountId: string; debit: string | null; credit: string | null }) => [
        l.accountId,
        l.debit,
        l.credit,
      ]),
    ).toEqual(
      expect.arrayContaining([
        [o.accounts['1140'], '24.0000', null],
        [o.accounts['5100'], null, '24.0000'],
      ]),
    );
    // The stock ledger records it, tied to the journal.
    const moves = (await o.owner.get(`/inventory/items/${o.itemId}/movements`)).body.data.items;
    expect(moves.map((m: { kind: string }) => m.kind)).toContain('sales_return');
    // The credit note's own journal was not touched.
    expect((await o.owner.get(`/sales/credit-notes/${note.id}`)).body.data.status).toBe('ISSUED');
  });

  it('uses the current average cost when the credit note has no invoice', async () => {
    const o = await stockOrg();
    await buy(o, '10', '12');
    const note = await credit(o, '2'); // no invoice
    const res = await post(o, returnBody(o, note.id, '2'));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.lines[0]).toMatchObject({ unitCost: '12', value: '24.0000' });
    expect(await stock(o)).toMatchObject({ quantity: '12', value: '144.0000' });
  });

  it('limits the quantity to what the credit note credited, summed over all returns', async () => {
    const o = await stockOrg();
    await buy(o, '10', '12');
    const invoice = await sell(o, '5');
    const note = await credit(o, '3', invoice.id);
    const returnable = (await o.owner.get(`/inventory/returns/returnable/${note.id}`)).body.data;
    expect(returnable.items).toEqual([
      { itemId: o.itemId, credited: '3', returned: '0', remaining: '3' },
    ]);
    expect((await post(o, returnBody(o, note.id, '2'))).status).toBe(201);
    const tooMuch = await post(o, returnBody(o, note.id, '2'));
    expect(tooMuch.status).toBe(400);
    expect(tooMuch.body.error.details.issues[0]).toMatchObject({ path: 'lines.0.quantity' });
    expect(tooMuch.body.error.details.issues[0].message).toMatch(/Only 1 of this item/);
    expect((await post(o, returnBody(o, note.id, '1'))).status).toBe(201);
    expect(
      (await o.owner.get(`/inventory/returns/returnable/${note.id}`)).body.data.items[0],
    ).toMatchObject({ returned: '3', remaining: '0' });
  });

  it('refuses what is not a valid return: a draft credit note, an unknown or untracked item, bad lines', async () => {
    const o = await stockOrg();
    await buy(o, '10', '12');
    const draft = await credit(o, '1', null, true);
    const onDraft = await post(o, returnBody(o, draft.id, '1'));
    expect(onDraft.status).toBe(400);
    expect(onDraft.body.error.details.issues[0].message).toMatch(/issued credit note/);
    const note = await credit(o, '1');
    const other = await o.owner.post('/sales/items', {
      name: 'Gift wrap',
      itemType: 'product',
      unitPrice: '5',
      revenueAccountId: o.accounts['4100'],
    });
    const wrongItem = await post(o, {
      ...returnBody(o, note.id, '1'),
      lines: [{ itemId: other.body.data.id, quantity: '1' }],
    });
    expect(wrongItem.status).toBe(400);
    expect(wrongItem.body.error.details.issues[0].message).toMatch(/not tracked in stock/);
    const missing = await post(o, returnBody(o, randomUUID(), '1'));
    expect(missing.status).toBe(400);
    expect((await post(o, returnBody(o, note.id, '0'))).status).toBe(400);
    expect((await post(o, { ...returnBody(o, note.id, '1'), lines: [] })).status).toBe(400);
    expect((await post(o, { ...returnBody(o, note.id, '1'), reason: '  ' })).status).toBe(400);
    expect((await post(o, { ...returnBody(o, note.id, '1'), extra: true })).status).toBe(400);
    expect(await stock(o)).toMatchObject({ quantity: '10' });
  });

  it('voids a return: the journal is reversed and the goods leave stock again; a void needs stock', async () => {
    const o = await stockOrg();
    await buy(o, '10', '12');
    const invoice = await sell(o, '4');
    const note = await credit(o, '3', invoice.id);
    const res = await post(o, returnBody(o, note.id, '3'));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await stock(o)).toMatchObject({ quantity: '9', value: '108.0000' });
    const voided = await o.owner.post(`/inventory/returns/${res.body.data.id}/void`, {
      version: res.body.data.version,
      reason: 'Entered by mistake',
    });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect(voided.body.data).toMatchObject({ status: 'VOID', voidReason: 'Entered by mistake' });
    expect(await stock(o)).toMatchObject({ quantity: '6', value: '72.0000' });
    expect(await glBalance(o.organizationId, o.accounts['1140']!)).toBe('72.00');
    expect(await glBalance(o.organizationId, o.accounts['5100']!)).toBe('48.00');
    // Once void, the quantity is available again for another return, and it cannot be voided twice.
    expect((await post(o, returnBody(o, note.id, '3'))).status).toBe(201);
    const again = await o.owner.post(`/inventory/returns/${res.body.data.id}/void`, {
      version: voided.body.data.version,
      reason: 'again',
    });
    expect(again.status).toBe(409);
    // A return whose goods were sold on cannot be voided: the stock is not there any more.
    const sold = await sell(o, '9');
    expect(sold.status).toBe('ISSUED');
    const second = (await o.owner.get('/inventory/returns')).body.data.items.find(
      (r: { status: string }) => r.status === 'POSTED',
    );
    const blocked = await o.owner.post(`/inventory/returns/${second.id}/void`, {
      version: second.version,
      reason: 'late',
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('INSUFFICIENT_STOCK');
  });

  it('is permission controlled and tenant isolated, and the journal cannot be reversed generically', async () => {
    const o = await stockOrg();
    await buy(o, '10', '12');
    const note = await credit(o, '2');
    const member = await joinWithRole(ctx, o.owner, 'Member'); // inventory.view only
    expect(
      (await post({ ...o, owner: member.client } as StockOrg, returnBody(o, note.id, '1'))).status,
    ).toBe(403);
    expect((await member.client.get('/inventory/returns')).status).toBe(200);
    const res = await post(o, returnBody(o, note.id, '1'));
    expect(res.status).toBe(201);
    expect(
      (
        await member.client.post(`/inventory/returns/${res.body.data.id}/void`, {
          version: 1,
          reason: 'x',
        })
      ).status,
    ).toBe(403);
    // The generic journal reversal refuses an Inventory journal.
    const generic = await o.owner.post(`/accounting/journals/${res.body.data.journalId}/reverse`, {
      reason: 'x',
      reversalDate: '2026-03-23',
    });
    expect(generic.status).toBeGreaterThanOrEqual(400);
    // Another organization sees nothing and cannot post against this credit note.
    const other = await stockOrg();
    expect((await other.owner.get('/inventory/returns')).body.data.items).toEqual([]);
    expect((await other.owner.get(`/inventory/returns/${res.body.data.id}`)).status).toBe(404);
    expect((await post(other, returnBody(other, note.id, '1'))).status).toBe(400);
  });

  it('replays an idempotent request and rejects tampering at the database', async () => {
    const o = await stockOrg();
    await buy(o, '10', '12');
    const note = await credit(o, '2');
    const key = randomUUID();
    const first = await o.owner.post('/inventory/returns', returnBody(o, note.id, '1'), {
      'idempotency-key': key,
    });
    const replay = await o.owner.post('/inventory/returns', returnBody(o, note.id, '1'), {
      'idempotency-key': key,
    });
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.body.data.id).toBe(first.body.data.id);
    expect(await stock(o)).toMatchObject({ quantity: '11' });
    await expect(
      owner.query(`UPDATE inventory_returns SET total_value = 1 WHERE id = $1`, [
        first.body.data.id,
      ]),
    ).rejects.toThrow(/immutable/);
    await expect(
      owner.query(`DELETE FROM inventory_returns WHERE id = $1`, [first.body.data.id]),
    ).rejects.toThrow(/never deleted/);
    await expect(
      owner.query(`UPDATE inventory_return_lines SET quantity = 9 WHERE return_id = $1`, [
        first.body.data.id,
      ]),
    ).rejects.toThrow();
  });
});

/** Goods returned to a supplier on a vendor credit (migration 0063). */
describe('returns to a supplier', () => {
  const vendorCredit = (o: StockOrg, quantity: string, unitPrice: string, accountId?: string) => ({
    origin: 'supplier_credit_note',
    vendorId: o.vendorId,
    creditDate: '2026-03-18',
    vendorReference: `CN-${randomUUID().slice(0, 8)}`,
    lines: [
      {
        itemId: o.itemId,
        accountId: accountId ?? o.accounts['1140'],
        description: 'Oil returned',
        quantity,
        unitPrice,
        taxCodeId: null,
      },
    ],
  });
  async function postCredit(o: StockOrg, body: object) {
    const draft = await o.owner.post('/purchases/vendor-credits', body);
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    return o.owner.post(`/purchases/vendor-credits/${draft.body.data.id}/post`, {
      version: draft.body.data.version,
    });
  }

  it('removes the stock at the value the credit booked, keeps stock equal to the ledger, and a void puts it back', async () => {
    const o = await stockOrg();
    await buy(o, '10', '12'); // 10 for 120
    const posted = await postCredit(o, vendorCredit(o, '4', '12'));
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    expect(await stock(o)).toMatchObject({ quantity: '6', value: '72.0000' });
    expect(await glBalance(o.organizationId, o.accounts['1140']!)).toBe('72.00');
    const moves = (await o.owner.get(`/inventory/items/${o.itemId}/movements`)).body.data.items;
    expect(moves.map((m: { kind: string }) => m.kind)).toContain('purchase_return');
    const voided = await o.owner.post(`/purchases/vendor-credits/${posted.body.data.id}/void`, {
      version: posted.body.data.version,
      reason: 'Supplier did not accept the goods',
    });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect(await stock(o)).toMatchObject({ quantity: '10', value: '120.0000' });
    expect(await glBalance(o.organizationId, o.accounts['1140']!)).toBe('120.00');
  });

  it('refuses a tracked item on any other account, and returning more than is on hand', async () => {
    const o = await stockOrg();
    await buy(o, '3', '12');
    const wrongAccount = await postCredit(o, vendorCredit(o, '1', '12', o.accounts['5400']));
    expect(wrongAccount.status).toBe(400);
    expect(wrongAccount.body.error.details.issues[0].path).toBe('lines.0.accountId');
    const tooMany = await postCredit(o, vendorCredit(o, '5', '12'));
    expect(tooMany.status).toBe(409);
    expect(tooMany.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(await stock(o)).toMatchObject({ quantity: '3' });
    expect(await glBalance(o.organizationId, o.accounts['1140']!)).toBe('36.00');
  });

  it('a void after the remaining goods were sold still restores the returned goods', async () => {
    const o = await stockOrg();
    await buy(o, '5', '12');
    const posted = await postCredit(o, vendorCredit(o, '2', '12'));
    expect(posted.status).toBe(200);
    await sell(o, '3');
    const voided = await o.owner.post(`/purchases/vendor-credits/${posted.body.data.id}/void`, {
      version: posted.body.data.version,
      reason: 'late',
    });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect(await stock(o)).toMatchObject({ quantity: '2' });
  });
});

describe('accounting invariants across returns', () => {
  it('keeps stock equal to the ledger, every journal balanced, and a posted document from posting twice', async () => {
    const o = await stockOrg();
    await buy(o, '20', '10'); // 20 at 200
    const invoice = await sell(o, '8'); // COGS 80, 12 left
    const note = await credit(o, '5', invoice.id);
    const ret = await post(o, returnBody(o, note.id, '5')); // +5 at 50 -> 17 on hand
    expect(ret.status, JSON.stringify(ret.body)).toBe(201);
    const draft = await o.owner.post('/purchases/vendor-credits', {
      origin: 'supplier_credit_note',
      vendorId: o.vendorId,
      creditDate: '2026-03-18',
      vendorReference: `CN-${randomUUID().slice(0, 8)}`,
      lines: [
        {
          itemId: o.itemId,
          accountId: o.accounts['1140'],
          description: 'Back to supplier',
          quantity: '4',
          unitPrice: '10',
          taxCodeId: null,
        },
      ],
    });
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    const posted = await o.owner.post(`/purchases/vendor-credits/${draft.body.data.id}/post`, {
      version: draft.body.data.version,
    });
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    // Posting the same credit again is refused and moves no stock.
    const again = await o.owner.post(`/purchases/vendor-credits/${draft.body.data.id}/post`, {
      version: draft.body.data.version,
    });
    expect(again.status).toBeGreaterThanOrEqual(400);
    expect(await stock(o)).toMatchObject({ quantity: '13', value: '130.0000' });

    const valuation = (await o.owner.get('/inventory/valuation')).body.data;
    expect(valuation.totalValue).toBe('130.0000');
    for (const account of valuation.accounts) expect(account.difference).toBe('0.0000');
    expect(await glBalance(o.organizationId, o.accounts['1140']!)).toBe('130.00');
    // COGS: 80 sold, 50 back.
    expect(await glBalance(o.organizationId, o.accounts['5100']!)).toBe('30.00');

    // Every journal of the organization balances (debits equal credits, in base and per entry).
    const { rows } = await owner.query(
      `SELECT j.id FROM accounting_journal_entries j
         JOIN accounting_journal_lines l ON l.journal_id = j.id AND l.organization_id = j.organization_id
        WHERE j.organization_id = $1
        GROUP BY j.id
       HAVING sum(coalesce(l.base_debit, 0)) <> sum(coalesce(l.base_credit, 0))`,
      [o.organizationId],
    );
    expect(rows).toEqual([]);

    // The stock ledger's running balance equals the sum of its movements.
    const sums = await owner.query(
      `SELECT coalesce(sum(quantity), 0)::text AS q, coalesce(sum(value), 0)::numeric(28,4)::text AS v
         FROM inventory_movements WHERE organization_id = $1 AND item_id = $2`,
      [o.organizationId, o.itemId],
    );
    expect(sums.rows[0]).toEqual({ q: '13.000000', v: '130.0000' });
  });
});
