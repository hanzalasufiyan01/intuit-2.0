import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { joinWithRole, setUpAccountingOrg } from './fixtures.js';
import { createTestContext, type TestContext } from './helpers.js';

/** Phase 3B step 19: Sales search (D15, Decision 47) — by number, reference and customer. */

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(() => ctx.close());

describe('Sales search (D15)', () => {
  it('finds documents by number, reference and customer name, per permission', async () => {
    const o = await setUpAccountingOrg(ctx);
    await o.owner.put('/sales/settings', {
      version: 0,
      arAccountId: o.accounts['1130'],
      defaultRevenueAccountId: o.accounts['4100'],
      defaultDepositAccountId: o.accounts['1120'],
      defaultTaxCodeId: null,
      defaultTaxTreatment: 'no_tax',
      defaultPaymentTermsDays: 30,
    });
    const customer = await o.owner.post('/customers', {
      party: { kind: 'organization', displayName: 'Manta Point Hotel', reference: 'MP-77' },
    });
    const other = await o.owner.post('/customers', {
      party: { kind: 'organization', displayName: 'Coconut Shop' },
    });
    const make = async (customerId: string, reference: string | null) => {
      const created = await o.owner.post('/sales/invoices', {
        customerId,
        invoiceDate: '2026-03-10',
        reference,
        lines: [{ description: 'Stay', quantity: '1', unitPrice: '100' }],
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      return created.body.data;
    };
    const manta = await make(customer.body.data.id, null);
    await make(other.body.data.id, 'PO-MANTA-1'); // matches by reference
    await make(other.body.data.id, null);
    await o.owner.post('/sales/items', { name: 'Manta snorkel trip', itemType: 'service' });

    // Lists: the invoice search also matches the customer's name and reference.
    const byName = (await o.owner.get('/sales/invoices?search=manta')).body.data.items;
    expect(byName).toHaveLength(2);
    const byCustomerRef = (await o.owner.get('/sales/invoices?search=mp-77')).body.data.items;
    expect(byCustomerRef.map((i: { id: string }) => i.id)).toEqual([manta.id]);

    const res = await o.owner.get('/sales/search?q=manta');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.customers.map((c: { displayName: string }) => c.displayName)).toEqual([
      'Manta Point Hotel',
    ]);
    expect(res.body.data.invoices).toHaveLength(2);
    expect(res.body.data.items.map((i: { name: string }) => i.name)).toEqual([
      'Manta snorkel trip',
    ]);
    expect(res.body.data.receipts).toEqual([]);
    // LIKE wildcards are literal.
    expect((await o.owner.get('/sales/search?q=%25%25')).body.data.invoices).toEqual([]);
    expect((await o.owner.get('/sales/search?q=m')).status).toBe(400);

    // Sections follow permissions: a customers-only role sees customers only.
    const role = await o.owner.post('/organizations/current/roles', {
      name: 'Customer lookup',
      permissionKeys: ['customers.view'],
    });
    expect(role.status).toBe(201);
    const viewer = await joinWithRole(ctx, o.owner, 'Customer lookup');
    const limited = (await viewer.client.get('/sales/search?q=manta')).body.data;
    expect(Object.keys(limited).sort()).toEqual(['customers', 'q']);
  });
});
