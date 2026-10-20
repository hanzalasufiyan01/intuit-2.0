import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { joinWithRole, setUpAccountingOrg, type AccountingOrg } from './fixtures.js';
import { connectAs, createTestContext, type TestContext } from './helpers.js';

/**
 * The online payment gateway (migration 0075) against the simulated provider: lifecycle,
 * confirmation against the provider, duplicate and forged webhooks, failure and review states,
 * tenant isolation and permissions. Real PostgreSQL.
 */

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

interface PayOrg extends AccountingOrg {
  customerId: string;
}

async function payOrg(mode: 'mock' | 'disabled' = 'mock'): Promise<PayOrg> {
  const org = await setUpAccountingOrg(ctx);
  const settings = await org.owner.put('/sales/settings', {
    version: 0,
    arAccountId: org.accounts['1130'],
    defaultRevenueAccountId: org.accounts['4100'],
    defaultDepositAccountId: org.accounts['1120'],
    defaultTaxCodeId: null,
    defaultTaxTreatment: 'no_tax',
    defaultPaymentTermsDays: 0,
  });
  expect(settings.status, JSON.stringify(settings.body)).toBe(200);
  const customer = await org.owner.post('/customers', {
    party: { kind: 'organization', displayName: 'Sun Island Resort' },
  });
  expect(customer.status, JSON.stringify(customer.body)).toBe(201);
  if (mode === 'mock') {
    const gw = await org.owner.put('/payments/settings', {
      version: 0,
      mode: 'mock',
      intentTtlMinutes: 60,
    });
    expect(gw.status, JSON.stringify(gw.body)).toBe(200);
  }
  return { ...org, customerId: customer.body.data.id };
}

async function issuedInvoice(o: PayOrg, amount = '500') {
  const draft = await o.owner.post('/sales/invoices', {
    customerId: o.customerId,
    invoiceDate: todayIso(),
    dueDate: todayIso(),
    lines: [{ description: 'Support', quantity: '1', unitPrice: amount }],
  });
  expect(draft.status, JSON.stringify(draft.body)).toBe(201);
  const issued = await o.owner.post(`/sales/invoices/${draft.body.data.id}/issue`, {
    version: draft.body.data.version,
  });
  expect(issued.status, JSON.stringify(issued.body)).toBe(200);
  return issued.body.data;
}

async function startPayment(o: PayOrg, invoiceId: string, amount?: string) {
  const res = await o.owner.post('/payments/intents', { invoiceId, ...(amount ? { amount } : {}) });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data;
}

const webhook = (delivery: { rawBody: string; headers: Record<string, string> }) =>
  ctx.app.inject({
    method: 'POST',
    url: '/api/v1/payments/webhooks/mock',
    headers: { 'content-type': 'application/json', ...delivery.headers },
    payload: delivery.rawBody,
  });

const receiptsFor = async (ref: string) =>
  (await db.query(`SELECT id, status FROM sales_receipts WHERE reference = $1`, [ref])).rows;

const intentRow = async (id: string) =>
  (await db.query(`SELECT * FROM payment_intents WHERE id = $1`, [id])).rows[0];

describe('settings', () => {
  it('is off by default, refuses a live provider, needs permission and records changes', async () => {
    const o = await payOrg('disabled');
    const initial = (await o.owner.get('/payments/settings')).body.data;
    expect(initial).toMatchObject({
      mode: 'disabled',
      version: 0,
      available: { mock: true, live: false },
    });
    const live = await o.owner.put('/payments/settings', {
      version: 0,
      mode: 'live',
      intentTtlMinutes: 60,
    });
    expect(live.status).toBe(400);
    expect(JSON.stringify(live.body)).toContain('No live payment provider');
    const on = await o.owner.put('/payments/settings', {
      version: 0,
      mode: 'mock',
      intentTtlMinutes: 30,
    });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(on.body.data).toMatchObject({ mode: 'mock', intentTtlMinutes: 30, version: 1 });
    expect(
      (
        await o.owner.put('/payments/settings', {
          version: 0,
          mode: 'disabled',
          intentTtlMinutes: 30,
        })
      ).status,
    ).toBe(409);
    expect(
      (await o.owner.put('/payments/settings', { version: 1, mode: 'mock', intentTtlMinutes: 1 }))
        .status,
    ).toBe(400);
    expect(
      (await o.owner.put('/payments/settings', { version: 1, mode: 'mock', extra: 1 })).status,
    ).toBe(400);
    const audit = await db.query(
      `SELECT metadata FROM audit_events WHERE organization_id = $1 AND action = 'payment.gateway_settings_updated'`,
      [o.organizationId],
    );
    expect(audit.rows[0].metadata).toMatchObject({ from: 'disabled', to: 'mock' });
    await o.owner.post('/organizations/current/roles', {
      name: 'Staff',
      permissionKeys: ['organization.read'],
    });
    const staff = await joinWithRole(ctx, o.owner, 'Staff');
    expect((await staff.client.get('/payments/settings')).status).toBe(403);
    expect(
      (
        await staff.client.put('/payments/settings', {
          version: 1,
          mode: 'disabled',
          intentTtlMinutes: 30,
        })
      ).status,
    ).toBe(403);
  });
});

describe('payment lifecycle', () => {
  it('collects an invoice: a verified, provider-confirmed webhook records the receipt exactly once', async () => {
    const o = await payOrg();
    const invoice = await issuedInvoice(o, '500');
    const intent = await startPayment(o, invoice.id);
    expect(intent).toMatchObject({
      status: 'PENDING',
      amount: '500',
      mode: 'mock',
      provider: 'mock',
    });
    expect(intent.checkoutUrl).toContain(`/mock-pay/${intent.providerRef}`);
    expect(await receiptsFor(intent.providerRef)).toHaveLength(0);

    const delivery = mock().settle(intent.providerRef, 'succeeded');
    const first = await webhook(delivery);
    expect(first.statusCode).toBe(200);
    expect(JSON.parse(first.body).data.outcome).toBe('applied');
    const receipts = await receiptsFor(intent.providerRef);
    expect(receipts).toHaveLength(1);
    const done = (await o.owner.get(`/payments/intents/${intent.id}`)).body.data;
    expect(done).toMatchObject({
      status: 'SUCCEEDED',
      receiptId: receipts[0].id,
      checkoutUrl: null,
    });
    expect(done.events).toEqual([
      expect.objectContaining({ source: 'webhook', outcome: 'applied' }),
    ]);
    const receipt = (await o.owner.get(`/sales/receipts/${receipts[0].id}`)).body.data;
    expect(receipt).toMatchObject({ amount: '500.00', amountUnallocated: '0.00' });
    expect(receipt.allocations).toEqual([
      expect.objectContaining({ invoiceId: invoice.id, amount: '500.00' }),
    ]);
    expect(receipt.memo).toContain('SIMULATED');

    // The same delivery again, and a repeated one in parallel, change nothing.
    expect(JSON.parse((await webhook(delivery)).body).data.outcome).toBe('duplicate');
    const burst = await Promise.all(Array.from({ length: 5 }, () => webhook(delivery)));
    expect(burst.every((r) => r.statusCode === 200)).toBe(true);
    expect(await receiptsFor(intent.providerRef)).toHaveLength(1);
    const events = await db.query(
      `SELECT count(*)::int AS n FROM payment_events WHERE intent_id = $1`,
      [intent.id],
    );
    expect(events.rows[0].n).toBe(1);
    // A fully paid invoice cannot be paid again.
    expect((await o.owner.post('/payments/intents', { invoiceId: invoice.id })).status).toBe(409);
    const actions = await db.query(
      `SELECT action FROM audit_events WHERE organization_id = $1 AND resource_id = $2 ORDER BY occurred_at, action`,
      [o.organizationId, intent.id],
    );
    expect(actions.rows.map((r: { action: string }) => r.action)).toEqual([
      'payment.intent_created',
      'payment.succeeded',
    ]);
  });

  it('pays part of an invoice and keeps one open attempt per invoice', async () => {
    const o = await payOrg();
    const invoice = await issuedInvoice(o, '500');
    for (const bad of ['0', '501', '10.123', 'x']) {
      expect(
        (await o.owner.post('/payments/intents', { invoiceId: invoice.id, amount: bad })).status,
        bad,
      ).toBe(400);
    }
    const intent = await startPayment(o, invoice.id, '200');
    // The same request returns the same attempt; a different amount is refused until it ends.
    const again = await startPayment(o, invoice.id, '200');
    expect(again.id).toBe(intent.id);
    expect(
      (await o.owner.post('/payments/intents', { invoiceId: invoice.id, amount: '100' })).status,
    ).toBe(409);
    await webhook(mock().settle(intent.providerRef, 'succeeded'));
    const receipt = (await receiptsFor(intent.providerRef))[0];
    expect((await o.owner.get(`/sales/receipts/${receipt.id}`)).body.data.amount).toBe('200.00');
    const rest = await startPayment(o, invoice.id);
    expect(rest.amount).toBe('300'); // what is still open
  });

  it('replays an idempotent create and validates the invoice', async () => {
    const o = await payOrg();
    const invoice = await issuedInvoice(o);
    const key = { 'idempotency-key': 'pay-1' };
    const a = await o.owner.post('/payments/intents', { invoiceId: invoice.id }, key);
    const b = await o.owner.post('/payments/intents', { invoiceId: invoice.id }, key);
    expect(a.status).toBe(201);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.body.data.id).toBe(a.body.data.id);
    const draft = await o.owner.post('/sales/invoices', {
      customerId: o.customerId,
      invoiceDate: todayIso(),
      dueDate: todayIso(),
      lines: [{ description: 'x', quantity: '1', unitPrice: '10' }],
    });
    expect(
      (await o.owner.post('/payments/intents', { invoiceId: draft.body.data.id })).status,
    ).toBe(409);
    expect((await o.owner.post('/payments/intents', { invoiceId: o.customerId })).status).toBe(404);
    expect(
      (await o.owner.post('/payments/intents', { invoiceId: invoice.id, extra: 1 })).status,
    ).toBe(400);
  });

  it('refuses to start a payment while the gateway is off', async () => {
    const o = await payOrg('disabled');
    const invoice = await issuedInvoice(o);
    const res = await o.owner.post('/payments/intents', { invoiceId: invoice.id });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('not switched on');
  });
});

describe('verification and confirmation', () => {
  it('rejects bad, missing and tampered signatures without touching anything', async () => {
    const o = await payOrg();
    const intent = await startPayment(o, (await issuedInvoice(o)).id);
    const good = mock().settle(intent.providerRef, 'succeeded');
    const wrong = {
      rawBody: good.rawBody,
      headers: { 'x-mock-signature': 'sha256=' + '0'.repeat(64) },
    };
    expect((await webhook(wrong)).statusCode).toBe(400);
    expect((await webhook({ rawBody: good.rawBody, headers: {} })).statusCode).toBe(400);
    const tampered = { rawBody: good.rawBody.replace('"500.00"', '"1.00"'), headers: good.headers };
    expect(tampered.rawBody).not.toBe(good.rawBody);
    expect((await webhook(tampered)).statusCode).toBe(400);
    expect((await intentRow(intent.id)).status).toBe('PENDING');
    expect(await receiptsFor(intent.providerRef)).toHaveLength(0);
    expect(
      (
        await ctx.app.inject({
          method: 'POST',
          url: '/api/v1/payments/webhooks/stripe',
          payload: '{}',
          headers: { 'content-type': 'application/json' },
        })
      ).statusCode,
    ).toBe(404);
  });

  it('does not trust a signed "succeeded" event the provider does not confirm', async () => {
    const o = await payOrg();
    const intent = await startPayment(o, (await issuedInvoice(o)).id);
    const forged = mock().forge(intent.providerRef, 'charge.succeeded', '500', 'MVR');
    const res = await webhook(forged);
    expect(JSON.parse(res.body).data.outcome).toBe('rejected');
    expect((await intentRow(intent.id)).status).toBe('PENDING');
    expect(await receiptsFor(intent.providerRef)).toHaveLength(0);
    const detail = (await o.owner.get(`/payments/intents/${intent.id}`)).body.data;
    expect(detail.events[0]).toMatchObject({
      outcome: 'rejected',
      detail: 'The provider does not confirm this payment.',
    });
  });

  it('parks a payment whose amount differs from the request for review, without recording it', async () => {
    const o = await payOrg();
    const intent = await startPayment(o, (await issuedInvoice(o)).id);
    mock().settle(intent.providerRef, 'succeeded');
    const lying = mock().delivery(intent.providerRef, {
      amount: '1',
      eventId: `evt-mismatch-${randomUUID()}`,
    });
    expect(JSON.parse((await webhook(lying)).body).data.outcome).toBe('rejected');
    const row = await intentRow(intent.id);
    expect(row.status).toBe('REQUIRES_REVIEW');
    expect(row.failure_code).toBe('amount_or_currency_mismatch');
    expect(await receiptsFor(intent.providerRef)).toHaveLength(0);
    // A person reconciles: the provider says 500 was paid, so it is recorded.
    const rec = await o.owner.post(`/payments/intents/${intent.id}/reconcile`, {});
    expect(rec.status, JSON.stringify(rec.body)).toBe(200);
    expect(rec.body.data.payment.status).toBe('SUCCEEDED');
    expect(await receiptsFor(intent.providerRef)).toHaveLength(1);
  });

  it('acknowledges events for payments it does not know', async () => {
    const forged = mock().forge('mock_ch_does_not_exist', 'charge.succeeded', '1', 'MVR');
    const res = await webhook(forged);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.outcome).toBe('unknown_payment');
  });
});

describe('failure, retry and review', () => {
  it('records a declined payment, then allows a new attempt', async () => {
    const o = await payOrg();
    const invoice = await issuedInvoice(o);
    const first = await startPayment(o, invoice.id);
    const declined = await webhook(
      mock().settle(first.providerRef, 'failed', { failureCode: 'card_declined' }),
    );
    expect(JSON.parse(declined.body).data.outcome).toBe('applied');
    expect(await intentRow(first.id)).toMatchObject({
      status: 'FAILED',
      failure_code: 'card_declined',
    });
    const second = await startPayment(o, invoice.id);
    expect(second.id).not.toBe(first.id);
    // A late "succeeded" for the failed attempt is still recorded: money received is never dropped.
    const late = mock().forge(first.providerRef, 'charge.succeeded', '500', 'MVR');
    expect(JSON.parse((await webhook(late)).body).data.outcome).toBe('rejected'); // provider says failed
    expect((await intentRow(first.id)).status).toBe('FAILED');
  });

  it('survives a provider outage when starting a payment', async () => {
    const o = await payOrg();
    const invoice = await issuedInvoice(o);
    mock().failNextCreate();
    const res = await o.owner.post('/payments/intents', { invoiceId: invoice.id });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      status: 'FAILED',
      failureCode: 'provider_unavailable',
      checkoutUrl: null,
    });
    const retry = await startPayment(o, invoice.id);
    expect(retry.status).toBe('PENDING');
  });

  it('parks a confirmed payment it cannot record and records it after the cause is fixed', async () => {
    const o = await payOrg();
    const invoice = await issuedInvoice(o);
    const intent = await startPayment(o, invoice.id);
    await db.query(
      `UPDATE sales_settings SET default_deposit_account_id = NULL WHERE organization_id = $1`,
      [o.organizationId],
    );
    const res = await webhook(mock().settle(intent.providerRef, 'succeeded'));
    expect(JSON.parse(res.body).data.outcome).toBe('failed');
    const parked = await intentRow(intent.id);
    expect(parked.status).toBe('REQUIRES_REVIEW');
    expect(await receiptsFor(intent.providerRef)).toHaveLength(0);
    const detail = (await o.owner.get(`/payments/intents/${intent.id}`)).body.data;
    expect(detail.events[0]).toMatchObject({ outcome: 'failed' });
    // The same delivery is not retried blindly; a person fixes the setting and reconciles.
    await db.query(
      `UPDATE sales_settings SET default_deposit_account_id = $2 WHERE organization_id = $1`,
      [o.organizationId, o.accounts['1120']],
    );
    const rec = await o.owner.post(`/payments/intents/${intent.id}/reconcile`, {});
    expect(rec.body.data.payment.status).toBe('SUCCEEDED');
    expect(await receiptsFor(intent.providerRef)).toHaveLength(1);
    const again = await o.owner.post(`/payments/intents/${intent.id}/reconcile`, {});
    expect(again.body.data.outcome).toBe('ignored');
    expect(await receiptsFor(intent.providerRef)).toHaveLength(1);
  });

  it('cancels a waiting payment, but not one the provider already took', async () => {
    const o = await payOrg();
    const a = await startPayment(o, (await issuedInvoice(o)).id);
    const cancelled = await o.owner.post(`/payments/intents/${a.id}/cancel`, {});
    expect(cancelled.body.data.status).toBe('CANCELLED');
    expect((await o.owner.post(`/payments/intents/${a.id}/cancel`, {})).status).toBe(409);
    const b = await startPayment(o, (await issuedInvoice(o)).id);
    mock().settle(b.providerRef, 'succeeded'); // paid at the provider, webhook not yet delivered
    expect((await o.owner.post(`/payments/intents/${b.id}/cancel`, {})).status).toBe(409);
    const rec = await o.owner.post(`/payments/intents/${b.id}/reconcile`, {});
    expect(rec.body.data.payment.status).toBe('SUCCEEDED');
  });

  it('records the money as customer credit when the invoice was settled meanwhile', async () => {
    const o = await payOrg();
    const invoice = await issuedInvoice(o, '400');
    const intent = await startPayment(o, invoice.id);
    const direct = await o.owner.post('/sales/receipts', {
      customerId: o.customerId,
      receiptDate: todayIso(),
      amount: '400',
      allocations: [{ invoiceId: invoice.id, amount: '400' }],
    });
    expect(direct.status, JSON.stringify(direct.body)).toBe(201);
    await webhook(mock().settle(intent.providerRef, 'succeeded'));
    const receipt = (await receiptsFor(intent.providerRef))[0];
    const detail = (await o.owner.get(`/sales/receipts/${receipt.id}`)).body.data;
    expect(detail).toMatchObject({ amount: '400.00', amountUnallocated: '400.00' });
    expect(detail.allocations).toEqual([]);
  });

  it('expires a payment the provider never completed', async () => {
    const o = await payOrg();
    await o.owner.put('/payments/settings', { version: 1, mode: 'mock', intentTtlMinutes: 5 });
    const intent = await startPayment(o, (await issuedInvoice(o)).id);
    ctx.clock.advance(20 * 60_000);
    expect(await ctx.services.payments.sweep()).toBeGreaterThanOrEqual(1);
    expect((await intentRow(intent.id)).status).toBe('EXPIRED');
    expect(await receiptsFor(intent.providerRef)).toHaveLength(0);
  });
});

describe('customer pays through a share link', () => {
  it('starts a payment, never trusts the redirect, and confirms with the provider', async () => {
    const o = await payOrg();
    const invoice = await issuedInvoice(o, '750');
    const link = (
      await o.owner.post(`/sales/invoices/${invoice.id}/share-links`, { expiresInDays: 7 })
    ).body.data;
    const anon = ctx.client();
    const started = await anon.post(`/public/invoices/${link.token}/pay`, {});
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    expect(started.headers['cache-control']).toBe('no-store');
    expect(started.body.data).toMatchObject({ status: 'PENDING', amount: '750' });
    // The browser comes back from "checkout" before anything was paid: still pending.
    const back = await anon.get(`/public/invoices/${link.token}/payment`);
    expect(back.body.data.payment.status).toBe('PENDING');
    expect(await receiptsFor(started.body.data.providerRef)).toHaveLength(0);
    // The provider takes the payment but the webhook is delayed; the status check confirms it.
    mock().settle(started.body.data.providerRef, 'succeeded');
    const after = await anon.get(`/public/invoices/${link.token}/payment`);
    expect(after.body.data.payment.status).toBe('SUCCEEDED');
    expect(await receiptsFor(started.body.data.providerRef)).toHaveLength(1);
    expect(JSON.stringify(after.body)).not.toContain(o.organizationId);
    expect((await anon.get(`/public/invoices/${link.token}`)).body.data.amountDue).toBe('0');
    // Garbage and revoked tokens look identical.
    expect((await anon.post(`/public/invoices/${'a'.repeat(43)}/pay`, {})).status).toBe(404);
    expect((await anon.get(`/public/invoices/${'a'.repeat(43)}/payment`)).status).toBe(404);
  });

  it('settles through the simulated checkout and refuses a revoked link', async () => {
    const o = await payOrg();
    const invoice = await issuedInvoice(o, '120');
    const link = (await o.owner.post(`/sales/invoices/${invoice.id}/share-links`, {})).body.data;
    const anon = ctx.client();
    const started = (await anon.post(`/public/invoices/${link.token}/pay`, {})).body.data;
    const settled = await anon.post(`/public/mock-pay/${started.providerRef}/settle`, {
      outcome: 'succeeded',
    });
    expect(settled.status, JSON.stringify(settled.body)).toBe(200);
    expect(settled.body.data).toMatchObject({ simulated: true, outcome: 'applied' });
    expect(await receiptsFor(started.providerRef)).toHaveLength(1);
    expect(
      (await anon.post('/public/mock-pay/mock_ch_nope/settle', { outcome: 'succeeded' })).status,
    ).toBe(404);
    expect(
      (await anon.post(`/public/mock-pay/${started.providerRef}/settle`, { outcome: 'bogus' }))
        .status,
    ).toBe(400);
    const other = await issuedInvoice(o, '60');
    const revoked = (await o.owner.post(`/sales/invoices/${other.id}/share-links`, {})).body.data;
    await o.owner.post(`/sales/share-links/${revoked.id}/revoke`, {});
    expect((await anon.post(`/public/invoices/${revoked.token}/pay`, {})).status).toBe(404);
  });

  it('refuses online payment through a link while the gateway is off', async () => {
    const o = await payOrg('disabled');
    const invoice = await issuedInvoice(o);
    const link = (await o.owner.post(`/sales/invoices/${invoice.id}/share-links`, {})).body.data;
    expect((await ctx.client().post(`/public/invoices/${link.token}/pay`, {})).status).toBe(409);
  });
});

describe('isolation, permissions and history', () => {
  it('keeps payments inside their organization and behind permissions', async () => {
    const a = await payOrg();
    const b = await payOrg();
    const invoice = await issuedInvoice(a);
    const intent = await startPayment(a, invoice.id);
    expect((await b.owner.get(`/payments/intents/${intent.id}`)).status).toBe(404);
    expect((await b.owner.post(`/payments/intents/${intent.id}/cancel`, {})).status).toBe(404);
    expect((await b.owner.post(`/payments/intents/${intent.id}/reconcile`, {})).status).toBe(404);
    expect((await b.owner.post('/payments/intents', { invoiceId: invoice.id })).status).toBe(404);
    expect((await b.owner.get('/payments/intents')).body.data).toEqual([]);
    await a.owner.post('/organizations/current/roles', {
      name: 'Staff',
      permissionKeys: ['organization.read'],
    });
    const staff = await joinWithRole(ctx, a.owner, 'Staff');
    expect((await staff.client.get('/payments/intents')).status).toBe(403);
    expect((await staff.client.get(`/payments/intents/${intent.id}`)).status).toBe(403);
    expect((await staff.client.post('/payments/intents', { invoiceId: invoice.id })).status).toBe(
      403,
    );
    expect((await staff.client.post(`/payments/intents/${intent.id}/reconcile`, {})).status).toBe(
      403,
    );
    expect((await ctx.client().get('/payments/intents')).status).toBe(401);
    expect((await ctx.client().post('/payments/intents', {})).status).toBe(401);
    // A webhook for A's payment never shows up for B.
    await webhook(mock().settle(intent.providerRef, 'succeeded'));
    expect((await b.owner.get('/payments/intents')).body.data).toEqual([]);
  });

  it('protects the history in the database', async () => {
    const o = await payOrg();
    const intent = await startPayment(o, (await issuedInvoice(o)).id);
    await webhook(mock().settle(intent.providerRef, 'succeeded'));
    await expect(
      db.query(`UPDATE payment_intents SET amount = 1 WHERE id = $1`, [intent.id]),
    ).rejects.toThrow(/fixed/);
    await expect(
      db.query(`UPDATE payment_intents SET status = 'PENDING', receipt_id = NULL WHERE id = $1`, [
        intent.id,
      ]),
    ).rejects.toThrow();
    await expect(
      db.query(`DELETE FROM payment_intents WHERE id = $1`, [intent.id]),
    ).rejects.toThrow(/never deleted/);
    await expect(
      db.query(`UPDATE payment_events SET outcome = 'ignored' WHERE intent_id = $1`, [intent.id]),
    ).rejects.toThrow();
    await expect(
      db.query(`DELETE FROM payment_events WHERE intent_id = $1`, [intent.id]),
    ).rejects.toThrow();
    // A provider event id is unique across the whole system.
    await expect(
      db.query(
        `INSERT INTO payment_events (organization_id, intent_id, provider, provider_event_id, event_type, source, outcome, payload_hash, received_at)
         SELECT organization_id, id, provider, 'mock_evt_' || $2::text || '_succeeded', 'charge.succeeded', 'webhook', 'ignored', repeat('a', 64), now()
           FROM payment_intents WHERE id = $1`,
        [intent.id, intent.providerRef],
      ),
    ).rejects.toThrow(/duplicate key/);
    // Only one open attempt per invoice, enforced by the database.
    const o2 = await payOrg();
    const inv = await issuedInvoice(o2);
    const open = await startPayment(o2, inv.id);
    await expect(
      db.query(
        `INSERT INTO payment_intents (organization_id, invoice_id, customer_id, amount, currency_code, provider, mode, status, expires_at, created_at, updated_at)
         SELECT organization_id, invoice_id, customer_id, 1, currency_code, provider, mode, 'PENDING', now(), now(), now()
           FROM payment_intents WHERE id = $1`,
        [open.id],
      ),
    ).rejects.toThrow(/payment_intents_one_open_idx/);
  });

  it('never exposes the provider reference secret material or card data in audit', async () => {
    const o = await payOrg();
    const intent = await startPayment(o, (await issuedInvoice(o)).id);
    await webhook(mock().settle(intent.providerRef, 'succeeded'));
    const audit = await db.query(
      `SELECT metadata::text AS m FROM audit_events WHERE organization_id = $1 AND resource_id = $2`,
      [o.organizationId, intent.id],
    );
    const text = audit.rows.map((r: { m: string }) => r.m).join(' ');
    expect(text).not.toContain('development-mock-webhook-secret');
    expect(text).not.toContain('sha256=');
  });
});
