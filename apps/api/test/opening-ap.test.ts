import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { setUpAccountingOrg, type AccountingOrg } from './fixtures.js';
import { connectAs, createTestContext, type TestClient, type TestContext } from './helpers.js';

/**
 * Opening AP documents (ADR 0004 P4-35, P4-36, P4-37; mirrors the Sales opening invoice, D5):
 * opening bills (Dr Opening Balance Equity / Cr AP) and opening vendor credits (Dr AP / Cr
 * Opening Balance Equity) dated on or before the S8 opening date, posted as `opening_balance`
 * system journals with an optional explicit base carrying value, then settled and voided like any
 * other AP document, with the AP subledger reconciling to the GL throughout.
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

interface Org extends AccountingOrg {
  vendorId: string;
}

async function apOrg(vendorCurrency = 'MVR'): Promise<Org> {
  const org = await setUpAccountingOrg(ctx);
  const settings = await org.owner.put('/purchases/settings', {
    version: 0,
    apAccountId: org.accounts['2110'],
    defaultExpenseAccountId: org.accounts['5400'],
    defaultPaymentAccountId: org.accounts['1120'],
    defaultTaxCodeId: null,
    defaultTaxTreatment: 'exclusive',
    defaultPaymentTermsDays: 30,
  });
  expect(settings.status, JSON.stringify(settings.body)).toBe(200);
  const vendor = await org.owner.post('/vendors', {
    party: { kind: 'organization', displayName: 'Island Supplies' },
    currencyCode: vendorCurrency,
  });
  expect(vendor.status, JSON.stringify(vendor.body)).toBe(201);
  return { ...org, vendorId: vendor.body.data.id };
}

const setConversionDate = async (client: TestClient, conversionDate = '2026-01-02') => {
  const res = await client.put('/accounting/settings/conversion-date', { conversionDate });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
};

const openingBill = (o: Org, overrides: Record<string, unknown> = {}) => ({
  kind: 'opening',
  vendorId: o.vendorId,
  billDate: '2026-01-01',
  lines: [{ description: 'Balance at conversion', quantity: '1', unitPrice: '1200' }],
  ...overrides,
});

const openingCredit = (o: Org, overrides: Record<string, unknown> = {}) => ({
  kind: 'opening',
  origin: 'supplier_credit_note',
  vendorId: o.vendorId,
  creditDate: '2026-01-01',
  lines: [{ description: 'Credit at conversion', quantity: '1', unitPrice: '300' }],
  ...overrides,
});

async function journalOf(o: AccountingOrg, journalId: string) {
  return (await o.owner.get(`/accounting/journals/${journalId}`)).body.data as {
    id: string;
    source: string;
    sourceModule: string;
    sourceType: string;
    sourceDocument: { documentType: string; label: string } | null;
    lines: {
      accountId: string;
      debit: string | null;
      credit: string | null;
      baseDebit: string | null;
      baseCredit: string | null;
    }[];
  };
}

const reconciliation = async (client: TestClient, asOf: string) =>
  (await client.get(`/purchases/reports/ap-reconciliation?asOf=${asOf}`)).body.data as {
    reconciled: boolean;
    glBalance: string;
  };

async function postBill(client: TestClient, bill: { id: string; version: number }) {
  return client.post(`/purchases/bills/${bill.id}/post`, { version: bill.version });
}

describe('opening bills', () => {
  it('needs the conversion date, dates on or before the opening date, and carries no tax or manual rate', async () => {
    const o = await apOrg();
    const noDate = await o.owner.post('/purchases/bills', openingBill(o));
    expect(noDate.status).toBe(400);
    expect(noDate.body.error.details.issues[0].path).toBe('kind');
    await setConversionDate(o.owner);
    const late = await o.owner.post('/purchases/bills', openingBill(o, { billDate: '2026-01-05' }));
    expect(late.body.error.details.issues[0].path).toBe('billDate');
    const taxed = await o.owner.post(
      '/purchases/bills',
      openingBill(o, { taxTreatment: 'exclusive' }),
    );
    expect(taxed.body.error.details.issues[0].path).toBe('taxTreatment');
    const manual = await o.owner.post(
      '/purchases/bills',
      openingBill(o, { rateOverride: '15', rateOverrideReason: 'x' }),
    );
    expect(manual.body.error.details.issues[0].path).toBe('rateOverride');
    const carryingBase = await o.owner.post(
      '/purchases/bills',
      openingBill(o, { openingBaseTotal: '1200' }),
    );
    expect(carryingBase.body.error.details.issues[0].path).toBe('openingBaseTotal');
    const created = await o.owner.post('/purchases/bills', openingBill(o));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data).toMatchObject({
      kind: 'opening',
      taxTotal: '0.00',
      total: '1200.00',
      vendorReference: null,
    });
    expect(created.body.data.approval.facts).toMatchObject({
      transactionType: 'opening',
      baseAmount: '1200.00',
    });
    // The kind is chosen at creation: an edit cannot send one.
    const edit = await o.owner.put(`/purchases/bills/${created.body.data.id}`, {
      ...openingBill(o, { billDate: '2025-12-31' }),
      version: created.body.data.version,
    });
    expect(edit.status, JSON.stringify(edit.body)).toBe(400);
    const fine = await o.owner.put(`/purchases/bills/${created.body.data.id}`, {
      vendorId: o.vendorId,
      billDate: '2025-12-31',
      lines: [{ description: 'Balance at conversion', quantity: '1', unitPrice: '1200' }],
      version: created.body.data.version,
    });
    expect(fine.status, JSON.stringify(fine.body)).toBe(200);
    expect(fine.body.data).toMatchObject({ kind: 'opening', billDate: '2025-12-31' });
  });

  it('posts Dr Opening Balance Equity / Cr AP as an opening_balance system journal and reconciles', async () => {
    const o = await apOrg();
    await setConversionDate(o.owner);
    const created = (await o.owner.post('/purchases/bills', openingBill(o))).body.data;
    const posted = await postBill(o.owner, created);
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    expect(posted.body.data).toMatchObject({
      kind: 'opening',
      status: 'POSTED',
      number: 'BILL-00001',
      exchangeRateSource: 'base',
      baseTotal: '1200.0000',
      amountDue: '1200.00',
    });
    const journal = await journalOf(o, posted.body.data.journalId);
    expect(journal).toMatchObject({
      source: 'system',
      sourceModule: 'purchases',
      sourceType: 'opening_balance',
    });
    expect(journal.sourceDocument).toMatchObject({
      documentType: 'bill',
      label: 'Opening bill BILL-00001',
    });
    expect(journal.lines.find((l) => l.accountId === o.accounts['3900'])).toMatchObject({
      debit: '1200.0000',
    });
    expect(journal.lines.find((l) => l.accountId === o.accounts['2110'])).toMatchObject({
      credit: '1200.0000',
      baseCredit: '1200.0000',
    });
    expect(await reconciliation(o.owner, '2026-01-31')).toMatchObject({
      glBalance: '1200.00',
      reconciled: true,
    });
    // It is an open AP balance like any bill.
    const aging = (await o.owner.get('/purchases/reports/aging?asOf=2026-01-31')).body.data;
    expect(aging.totals.total).toBe('1200.00');
    // Spend reports leave opening balances out: they are not purchases of the period.
    const spend = (
      await o.owner.get('/purchases/reports/purchases-by-vendor?from=2025-12-01&to=2026-01-31')
    ).body.data;
    expect(spend.vendors).toEqual([]);

    // Generic reversal is refused (E2); the bill void reverses it.
    const manual = await o.owner.post(`/accounting/journals/${journal.id}/reverse`, {
      reason: 'Manual attempt',
    });
    expect(manual.body.error.code).toBe('SYSTEM_JOURNAL');
    const voided = await o.owner.post(`/purchases/bills/${created.id}/void`, {
      version: posted.body.data.version,
      reason: 'Wrong balance',
    });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect(await reconciliation(o.owner, '2026-01-31')).toMatchObject({
      glBalance: '0.00',
      reconciled: true,
    });
  });

  it('carries a foreign opening balance at its explicit carrying value (S8-06)', async () => {
    const o = await apOrg('USD');
    await setConversionDate(o.owner);
    const created = await o.owner.post(
      '/purchases/bills',
      openingBill(o, {
        openingBaseTotal: '15400',
        lines: [{ description: 'Balance at conversion', quantity: '1', unitPrice: '1000' }],
      }),
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const posted = await postBill(o.owner, created.body.data);
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    expect(posted.body.data).toMatchObject({
      kind: 'opening',
      currencyCode: 'USD',
      exchangeRateSource: 'carrying',
      exchangeRate: '15.4000000000',
      baseTotal: '15400.0000',
      openingBaseTotal: '15400.0000',
      baseDue: '15400.0000',
    });
    const journal = await journalOf(o, posted.body.data.journalId);
    expect(journal.lines.find((l) => l.accountId === o.accounts['2110'])).toMatchObject({
      credit: '1000.0000',
      baseCredit: '15400.0000',
    });
    expect(await reconciliation(o.owner, '2026-01-31')).toMatchObject({
      glBalance: '15400.00',
      reconciled: true,
    });
    // The carrying value is immutable at the database once posted.
    await expect(
      owner.query(`UPDATE purchases_bills SET opening_base_total = 99 WHERE id = $1`, [
        created.body.data.id,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('is settled by a payment like any bill, and a standard bill still needs its supplier reference', async () => {
    const o = await apOrg();
    await setConversionDate(o.owner);
    const created = (await o.owner.post('/purchases/bills', openingBill(o))).body.data;
    const bill = (await postBill(o.owner, created)).body.data;
    const draft = await o.owner.post('/purchases/payments', {
      vendorId: o.vendorId,
      paymentDate: '2026-02-10',
      amount: '500',
      allocations: [{ billId: bill.id, amount: '500' }],
    });
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    const paid = await o.owner.post(`/purchases/payments/${draft.body.data.id}/record`, {
      version: draft.body.data.version,
    });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect((await o.owner.get(`/purchases/bills/${bill.id}`)).body.data.amountDue).toBe('700.00');
    expect(await reconciliation(o.owner, '2026-02-28')).toMatchObject({
      glBalance: '700.00',
      reconciled: true,
    });
    // A part-paid opening bill cannot be voided (the same rule as every bill).
    const voided = await o.owner.post(`/purchases/bills/${bill.id}/void`, {
      version: (await o.owner.get(`/purchases/bills/${bill.id}`)).body.data.version,
      reason: 'x',
    });
    expect(voided.body.error.code).toBe('INVALID_STATE_TRANSITION');
    // A standard bill without a supplier reference is still refused at post.
    const standard = await o.owner.post('/purchases/bills', {
      vendorId: o.vendorId,
      billDate: '2026-02-10',
      lines: [{ description: 'Stock', quantity: '1', unitPrice: '10', taxCodeId: null }],
    });
    const refused = await postBill(o.owner, standard.body.data);
    expect(refused.status).toBe(400);
    expect(refused.body.error.details.issues.map((i: { path: string }) => i.path)).toContain(
      'vendorReference',
    );
  });
});

describe('opening vendor credits', () => {
  it('posts Dr AP / Cr Opening Balance Equity, reconciles, and voids while unapplied', async () => {
    const o = await apOrg();
    await setConversionDate(o.owner);
    const created = await o.owner.post('/purchases/vendor-credits', openingCredit(o));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data).toMatchObject({
      kind: 'opening',
      origin: 'supplier_credit_note',
      vendorReference: null,
      total: '300.00',
    });
    expect(created.body.data.approval.facts).toMatchObject({ transactionType: 'opening' });
    const posted = await o.owner.post(`/purchases/vendor-credits/${created.body.data.id}/post`, {
      version: created.body.data.version,
    });
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    expect(posted.body.data).toMatchObject({
      kind: 'opening',
      status: 'POSTED',
      number: 'VC-00001',
      baseTotal: '300.0000',
      amountUnapplied: '300.00',
    });
    const journal = await journalOf(o, posted.body.data.journalId);
    expect(journal).toMatchObject({ source: 'system', sourceType: 'opening_balance' });
    expect(journal.lines.find((l) => l.accountId === o.accounts['2110'])).toMatchObject({
      debit: '300.0000',
    });
    expect(journal.lines.find((l) => l.accountId === o.accounts['3900'])).toMatchObject({
      credit: '300.0000',
    });
    expect(await reconciliation(o.owner, '2026-01-31')).toMatchObject({
      glBalance: '-300.00',
      reconciled: true,
    });
    const voided = await o.owner.post(`/purchases/vendor-credits/${created.body.data.id}/void`, {
      version: posted.body.data.version,
      reason: 'Wrong balance',
    });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect(await reconciliation(o.owner, '2026-01-31')).toMatchObject({
      glBalance: '0.00',
      reconciled: true,
    });
  });

  it('allows only a supplier credit note without a bill link or manual rate, dated by the opening date', async () => {
    const o = await apOrg();
    await setConversionDate(o.owner);
    const note = await o.owner.post(
      '/purchases/vendor-credits',
      openingCredit(o, { origin: 'debit_note' }),
    );
    expect(note.body.error.details.issues[0].path).toBe('kind');
    const late = await o.owner.post(
      '/purchases/vendor-credits',
      openingCredit(o, { creditDate: '2026-02-01' }),
    );
    expect(late.body.error.details.issues[0].path).toBe('creditDate');
    const taxed = await o.owner.post(
      '/purchases/vendor-credits',
      openingCredit(o, { taxTreatment: 'exclusive' }),
    );
    expect(taxed.body.error.details.issues[0].path).toBe('taxTreatment');
    const manual = await o.owner.post(
      '/purchases/vendor-credits',
      openingCredit(o, { rateOverride: '15', rateOverrideReason: 'x' }),
    );
    expect(manual.body.error.details.issues[0].path).toBe('rateOverride');
  });

  it('carries a foreign opening credit at its explicit carrying value', async () => {
    const o = await apOrg('USD');
    await setConversionDate(o.owner);
    const created = await o.owner.post(
      '/purchases/vendor-credits',
      openingCredit(o, {
        openingBaseTotal: '4620',
        lines: [{ description: 'Credit at conversion', quantity: '1', unitPrice: '300' }],
      }),
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const posted = await o.owner.post(`/purchases/vendor-credits/${created.body.data.id}/post`, {
      version: created.body.data.version,
    });
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    expect(posted.body.data).toMatchObject({
      exchangeRateSource: 'carrying',
      exchangeRate: '15.4000000000',
      baseTotal: '4620.0000',
      baseUnapplied: '4620.0000',
    });
    expect(await reconciliation(o.owner, '2026-01-31')).toMatchObject({
      glBalance: '-4620.00',
      reconciled: true,
    });
  });
});
