import { createHash } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { joinWithRole, setUpAccountingOrg, type AccountingOrg } from './fixtures.js';
import { connectAs, createTestContext, type TestContext } from './helpers.js';

/** Customer statement links, the first step of the customer portal (migration 0076). */

let ctx: TestContext;
let db: pg.Client;
beforeAll(async () => {
  ctx = await createTestContext();
  db = await connectAs('owner');
});
afterAll(async () => {
  await db.end();
  await ctx.close();
});

const mock = () => ctx.services.mockPayments!;
const todayIso = () => ctx.clock.now().toISOString().slice(0, 10);

interface Org extends AccountingOrg {
  customerId: string;
}

async function org(): Promise<Org> {
  const o = await setUpAccountingOrg(ctx);
  expect(
    (
      await o.owner.put('/sales/settings', {
        version: 0,
        arAccountId: o.accounts['1130'],
        defaultRevenueAccountId: o.accounts['4100'],
        defaultDepositAccountId: o.accounts['1120'],
        defaultTaxCodeId: null,
        defaultTaxTreatment: 'no_tax',
        defaultPaymentTermsDays: 0,
      })
    ).status,
  ).toBe(200);
  expect(
    (await o.owner.put('/payments/settings', { version: 0, mode: 'mock', intentTtlMinutes: 60 }))
      .status,
  ).toBe(200);
  const customer = await newCustomer(o, 'Sun Island Resort');
  return { ...o, customerId: customer };
}

async function newCustomer(o: AccountingOrg, name: string) {
  const res = await o.owner.post('/customers', {
    party: {
      kind: 'organization',
      displayName: name,
      email: `${name.replaceAll(' ', '').toLowerCase()}@x.test`,
    },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.id as string;
}

async function issued(o: AccountingOrg, customerId: string, amount: string) {
  const draft = await o.owner.post('/sales/invoices', {
    customerId,
    invoiceDate: todayIso(),
    dueDate: todayIso(),
    lines: [{ description: 'Support', quantity: '1', unitPrice: amount }],
  });
  const res = await o.owner.post(`/sales/invoices/${draft.body.data.id}/issue`, {
    version: draft.body.data.version,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data;
}

const link = async (o: Org, customerId = o.customerId, days = 30) => {
  const res = await o.owner.post(`/customers/${customerId}/statement-links`, {
    expiresInDays: days,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as { id: string; token: string; url: string };
};

describe('statement links', () => {
  it('shows one customer open invoices and receipts, and nothing else, without a session', async () => {
    const o = await org();
    const other = await newCustomer(o, 'Other Customer');
    const a = await issued(o, o.customerId, '500');
    const b = await issued(o, o.customerId, '250');
    await issued(o, other, '999');
    const receipt = await o.owner.post('/sales/receipts', {
      customerId: o.customerId,
      receiptDate: todayIso(),
      amount: '100',
      reference: 'CHQ-77',
      allocations: [{ invoiceId: b.id, amount: '100' }],
    });
    expect(receipt.status, JSON.stringify(receipt.body)).toBe(201);
    const l = await link(o);
    expect(l.url).toContain(`/p/statement/${l.token}`);
    const anon = ctx.client();
    const view = await anon.get(`/public/statements/${l.token}`);
    expect(view.status, JSON.stringify(view.body)).toBe(200);
    expect(view.headers['cache-control']).toBe('no-store');
    expect(view.body.data).toMatchObject({
      customerName: 'Sun Island Resort',
      balances: [{ currencyCode: expect.any(String), amount: '650' }],
    });
    const numbers = view.body.data.invoices.map((i: { number: string; openAmount: string }) => [
      i.number,
      i.openAmount,
    ]);
    expect(numbers).toEqual(
      expect.arrayContaining([
        [a.number, '500'],
        [b.number, '150'],
      ]),
    );
    expect(view.body.data.invoices).toHaveLength(2);
    expect(view.body.data.receipts).toEqual([
      expect.objectContaining({ amount: '100', reference: 'CHQ-77' }),
    ]);
    const text = JSON.stringify(view.body);
    for (const leak of [
      o.organizationId,
      o.customerId,
      other,
      'journal',
      'sunislandresort@x.test',
      'Other Customer',
    ]) {
      expect(text).not.toContain(leak);
    }
    // Views are counted; the token is never stored or listed; only the hash is in the database.
    const links = (await o.owner.get(`/customers/${o.customerId}/statement-links`)).body.data;
    expect(links[0]).toMatchObject({ id: l.id, status: 'active', viewCount: 1 });
    expect(JSON.stringify(links)).not.toContain(l.token);
    const stored = await db.query(`SELECT token_hash FROM customer_statement_links WHERE id = $1`, [
      l.id,
    ]);
    expect(stored.rows[0].token_hash).toBe(createHash('sha256').update(l.token).digest('hex'));
    const audit = await db.query(
      `SELECT metadata::text AS m FROM audit_events WHERE organization_id = $1 AND action LIKE 'customer.statement_link%'`,
      [o.organizationId],
    );
    expect(audit.rows.map((r: { m: string }) => r.m).join(' ')).not.toContain(l.token);
  });

  it('lets the customer pay an open invoice from the statement, confirmed by the provider', async () => {
    const o = await org();
    const inv = await issued(o, o.customerId, '300');
    const l = await link(o);
    const anon = ctx.client();
    const started = await anon.post(`/public/statements/${l.token}/invoices/${inv.id}/pay`, {});
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    expect(started.body.data).toMatchObject({ status: 'PENDING', amount: '300' });
    let view = (await anon.get(`/public/statements/${l.token}`)).body.data;
    expect(view.invoices[0].payment.status).toBe('PENDING');
    expect(view.balances[0].amount).toBe('300');
    mock().settle(started.body.data.providerRef, 'succeeded'); // provider paid; webhook not delivered
    view = (await anon.get(`/public/statements/${l.token}`)).body.data;
    expect(view.balances).toEqual([]);
    expect(view.invoices).toEqual([]);
    expect(view.receipts).toHaveLength(1);
    // Another customer's invoice cannot be paid through this statement.
    const other = await newCustomer(o, 'Third Customer');
    const foreign = await issued(o, other, '40');
    expect(
      (await anon.post(`/public/statements/${l.token}/invoices/${foreign.id}/pay`, {})).status,
    ).toBe(404);
    expect(
      (await anon.post(`/public/statements/${l.token}/invoices/${o.customerId}/pay`, {})).status,
    ).toBe(404);
  });

  it('treats unknown, expired and revoked links alike and rate limits the public routes', async () => {
    const o = await org();
    await issued(o, o.customerId, '10');
    const anon = ctx.client();
    expect((await anon.get(`/public/statements/${'a'.repeat(43)}`)).status).toBe(404);
    expect((await anon.get('/public/statements/short')).status).toBe(400);
    const l = await link(o);
    expect((await o.owner.post(`/customers/statement-links/${l.id}/revoke`, {})).status).toBe(200);
    expect((await o.owner.post(`/customers/statement-links/${l.id}/revoke`, {})).status).toBe(409);
    const gone = await anon.get(`/public/statements/${l.token}`);
    expect(gone.status).toBe(404);
    expect(gone.body.error.message).toBe('This link is not valid.');
    // Expiry is fixed in the database; move the clock to expire a link.
    const short = await link(o, o.customerId, 1);
    ctx.clock.advance(2 * 86_400_000);
    expect((await anon.get(`/public/statements/${short.token}`)).status).toBe(404);
    const ip = '203.0.113.77';
    const limited = ctx.client(ip);
    let status = 200;
    for (let i = 0; i < 40 && status !== 429; i += 1) {
      status = (await limited.get(`/public/statements/${'b'.repeat(43)}`)).status;
    }
    expect(status).toBe(429);
  });

  it('is permission checked, tenant isolated and protected in the database', async () => {
    const a = await org();
    const b = await org();
    const l = await link(a);
    expect((await b.owner.post(`/customers/${a.customerId}/statement-links`, {})).status).toBe(404);
    expect((await b.owner.get(`/customers/${a.customerId}/statement-links`)).status).toBe(404);
    expect((await b.owner.post(`/customers/statement-links/${l.id}/revoke`, {})).status).toBe(404);
    await a.owner.post('/organizations/current/roles', {
      name: 'Staff',
      permissionKeys: ['organization.read'],
    });
    const staff = await joinWithRole(ctx, a.owner, 'Staff');
    expect((await staff.client.post(`/customers/${a.customerId}/statement-links`, {})).status).toBe(
      403,
    );
    expect((await staff.client.get(`/customers/${a.customerId}/statement-links`)).status).toBe(403);
    expect((await ctx.client().post(`/customers/${a.customerId}/statement-links`, {})).status).toBe(
      401,
    );
    expect(
      (await a.owner.post(`/customers/${a.customerId}/statement-links`, { expiresInDays: 400 }))
        .status,
    ).toBe(400);
    expect(
      (await a.owner.post(`/customers/${a.customerId}/statement-links`, { extra: 1 })).status,
    ).toBe(400);
    await expect(
      db.query(`UPDATE customer_statement_links SET customer_id = $2 WHERE id = $1`, [
        l.id,
        b.customerId,
      ]),
    ).rejects.toThrow();
    await expect(
      db.query(`DELETE FROM customer_statement_links WHERE id = $1`, [l.id]),
    ).rejects.toThrow(/never deleted/);
    // The same token never opens the other organization's data.
    const view = (await ctx.client().get(`/public/statements/${l.token}`)).body.data;
    expect(JSON.stringify(view)).not.toContain(b.organizationId);
  });
});
