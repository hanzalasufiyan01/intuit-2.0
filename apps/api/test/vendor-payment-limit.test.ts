import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setUpAccountingOrg } from './fixtures.js';
import { createTestContext, type TestContext } from './helpers.js';

/**
 * Phase 4B-2, P4-50 with decision C1: one payment settles at most 497 bills, and its journal —
 * 497 AP lines, the prepayment line, the payment-account line and ONE net realized-FX line — is
 * exactly the 500-line journal cap.
 */

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});

describe('the 497-bill payment limit (P4-50, C1)', () => {
  it('settles 497 foreign-currency bills in one payment within the 500-line journal', async () => {
    const o = await setUpAccountingOrg(ctx);
    const settings = await o.owner.put('/purchases/settings', {
      version: 0,
      apAccountId: o.accounts['2110'],
      defaultExpenseAccountId: o.accounts['5400'],
      defaultPaymentAccountId: o.accounts['1120'],
      defaultTaxCodeId: null,
      defaultTaxTreatment: 'exclusive',
      defaultPaymentTermsDays: 30,
    });
    expect(settings.status).toBe(200);
    const vendor = await o.owner.post('/vendors', {
      party: { kind: 'organization', displayName: 'Bulk Supplier' },
      currencyCode: 'USD',
    });
    const vendorId = vendor.body.data.id as string;
    for (const [rateDate, rate] of [
      ['2026-03-01', '15.42'],
      ['2026-03-15', '15.50'],
    ]) {
      await o.owner.post('/accounting/exchange-rates', { fromCurrency: 'USD', rateDate, rate });
    }
    const billIds: string[] = [];
    const postOne = async () => {
      const bill = await o.owner.post('/purchases/bills', {
        vendorId,
        billDate: '2026-03-10',
        vendorReference: `INV-${randomUUID()}`,
        lines: [{ description: 'Part', quantity: '1', unitPrice: '1', taxCodeId: null }],
      });
      expect(bill.status, JSON.stringify(bill.body)).toBe(201);
      const posted = await o.owner.post(`/purchases/bills/${bill.body.data.id}/post`, {
        version: bill.body.data.version,
      });
      expect(posted.status, JSON.stringify(posted.body)).toBe(200);
      billIds.push(bill.body.data.id);
    };
    for (let i = 0; i < 497; i += 8) {
      await Promise.all(Array.from({ length: Math.min(8, 497 - i) }, postOne));
    }
    expect(billIds).toHaveLength(497);
    const draft = await o.owner.post('/purchases/payments', {
      vendorId,
      paymentDate: '2026-03-20',
      amount: '498',
      allocations: billIds.map((billId) => ({ billId, amount: '1' })),
    });
    expect(draft.status, JSON.stringify(draft.body).slice(0, 500)).toBe(201);
    const recorded = await o.owner.post(`/purchases/payments/${draft.body.data.id}/record`, {
      version: draft.body.data.version,
    });
    expect(recorded.status, JSON.stringify(recorded.body).slice(0, 500)).toBe(200);
    expect(recorded.body.data).toMatchObject({ amountUnallocated: '1.00' });
    expect(recorded.body.data.allocations).toHaveLength(497);
    const journal = (await o.owner.get(`/accounting/journals/${recorded.body.data.journalId}`)).body
      .data;
    expect(journal.lines).toHaveLength(500);
    // Each bill: 15.42 relieved − 15.50 paid = −0.08; net −39.76 as one base-only debit.
    const fx = journal.lines.filter((l: { kind: string }) => l.kind === 'base_only');
    expect(fx).toEqual([expect.objectContaining({ baseDebit: '39.7600', baseCredit: null })]);
  }, 600_000);
});
