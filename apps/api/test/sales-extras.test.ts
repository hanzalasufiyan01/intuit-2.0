import { createHash } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { joinWithRole, setUpAccountingOrg, type AccountingOrg } from './fixtures.js';
import { connectAs, createTestContext, type TestContext } from './helpers.js';

/**
 * Payment reminders, sales orders and read-only invoice share links (FP-28, migration 0070).
 * Real PostgreSQL; the e-mail provider is the in-memory mock.
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

const todayIso = () => ctx.clock.now().toISOString().slice(0, 10);
const shift = (iso: string, days: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

interface SalesOrg extends AccountingOrg {
  customerId: string;
  customerEmail: string;
  itemId: string;
}

async function salesOrg(email: string | null = 'ap@sunisland.test'): Promise<SalesOrg> {
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
  const unique = `${Math.random().toString(36).slice(2, 8)}`;
  const customerEmail = email === null ? '' : `${unique}.${email}`;
  const customer = await org.owner.post('/customers', {
    party: {
      kind: 'organization',
      displayName: 'Sun Island Resort',
      ...(email === null ? {} : { email: customerEmail }),
    },
  });
  expect(customer.status, JSON.stringify(customer.body)).toBe(201);
  const item = await org.owner.post('/sales/items', {
    name: 'Consulting hour',
    itemType: 'service',
    unitPrice: '100',
    revenueAccountId: org.accounts['4200'],
  });
  return { ...org, customerId: customer.body.data.id, customerEmail, itemId: item.body.data.id };
}

async function issuedInvoice(o: SalesOrg, invoiceDate: string, amount = '500') {
  const draft = await o.owner.post('/sales/invoices', {
    customerId: o.customerId,
    invoiceDate,
    dueDate: invoiceDate,
    lines: [{ description: 'Support', quantity: '1', unitPrice: amount }],
  });
  expect(draft.status, JSON.stringify(draft.body)).toBe(201);
  const issued = await o.owner.post(`/sales/invoices/${draft.body.data.id}/issue`, {
    version: draft.body.data.version,
  });
  expect(issued.status, JSON.stringify(issued.body)).toBe(200);
  return issued.body.data;
}

describe('payment reminders', () => {
  it('lists overdue open invoices and sends one reminder, at most one a day, without personal data in the audit', async () => {
    const o = await salesOrg();
    const overdue = await issuedInvoice(o, shift(todayIso(), -20));
    await issuedInvoice(o, todayIso()); // due today: not overdue
    const list = (await o.owner.get('/sales/reminders/overdue')).body.data;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      invoiceId: overdue.id,
      daysOverdue: 20,
      openAmount: '500',
      hasEmail: true,
      remindersSent: 0,
    });
    const sent = await o.owner.post(`/sales/reminders/invoices/${overdue.id}/send`, {});
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    const mail = ctx.email.lastTo(o.customerEmail);
    expect(mail?.subject).toBe(`Payment reminder: invoice ${overdue.number}`);
    expect(mail?.text).toContain('20 days overdue');
    const again = await o.owner.post(`/sales/reminders/invoices/${overdue.id}/send`, {});
    expect(again.status).toBe(409);
    expect((await o.owner.get('/sales/reminders/overdue')).body.data[0].remindersSent).toBe(1);
    const audit = await db.query(
      `SELECT metadata::text AS metadata FROM audit_events WHERE organization_id = $1 AND action = 'payment_reminder.sent'`,
      [o.organizationId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].metadata).not.toContain(o.customerEmail);
    expect(audit.rows[0].metadata).not.toContain('Sun Island');
    await expect(
      db.query(`UPDATE payment_reminders SET recipient = 'x@y.z' WHERE organization_id = $1`, [
        o.organizationId,
      ]),
    ).rejects.toThrow();
  });

  it('refuses invoices that are not overdue and open, and needs an address', async () => {
    const o = await salesOrg(null);
    const overdue = await issuedInvoice(o, shift(todayIso(), -5));
    const current = await issuedInvoice(o, todayIso());
    expect((await o.owner.post(`/sales/reminders/invoices/${current.id}/send`, {})).status).toBe(
      404,
    );
    const noEmail = await o.owner.post(`/sales/reminders/invoices/${overdue.id}/send`, {});
    expect(noEmail.status).toBe(400);
    expect(noEmail.body.error.details.issues[0].path).toBe('to');
    const bad = await o.owner.post(`/sales/reminders/invoices/${overdue.id}/send`, {
      to: 'not an address',
    });
    expect(bad.status).toBe(400);
    const ok = await o.owner.post(`/sales/reminders/invoices/${overdue.id}/send`, {
      to: 'billing@elsewhere.test',
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    // Once paid in full it is no longer open.
    const receipt = await o.owner.post('/sales/receipts', {
      customerId: o.customerId,
      receiptDate: todayIso(),
      amount: '500',
      allocations: [{ invoiceId: overdue.id, amount: '500' }],
    });
    expect(receipt.status, JSON.stringify(receipt.body)).toBe(201);
    expect((await o.owner.get('/sales/reminders/overdue')).body.data).toEqual([]);
  });

  it('runs the automatic schedule in stages, once each, only when switched on', async () => {
    const o = await salesOrg();
    const old = await issuedInvoice(o, shift(todayIso(), -30));
    const fresh = await issuedInvoice(o, shift(todayIso(), -2));
    // The run is global (every organization with the schedule on), and the database is shared with
    // other test files, so this test counts only its own organization's reminders.
    const ownAuto = async () =>
      (
        await db.query(
          `SELECT count(*)::int AS n FROM payment_reminders WHERE organization_id = $1 AND kind = 'auto'`,
          [o.organizationId],
        )
      ).rows[0].n as number;
    // Off by default.
    await ctx.services.reminders.runAuto();
    expect(await ownAuto()).toBe(0);
    const settings = await o.owner.put('/sales/reminders/settings', {
      version: 0,
      autoEnabled: true,
      firstAfterDays: 3,
      repeatEveryDays: 7,
      maxReminders: 2,
    });
    expect(settings.status, JSON.stringify(settings.body)).toBe(200);
    // Other organizations' schedules are switched off for this run.
    await db.query(
      `UPDATE payment_reminder_settings SET auto_enabled = false WHERE organization_id <> $1`,
      [o.organizationId],
    );
    await ctx.services.reminders.runAuto();
    expect(await ownAuto()).toBe(1); // the old invoice, stage 1; the fresh one is only 2 days overdue
    await ctx.services.reminders.runAuto();
    expect(await ownAuto()).toBe(2); // stage 2: 30 days overdue is past 3 + 7
    await ctx.services.reminders.runAuto();
    expect(await ownAuto()).toBe(2); // the maximum of 2 was reached
    const stages = await db.query(
      `SELECT invoice_id, stage FROM payment_reminders WHERE organization_id = $1 AND kind = 'auto' ORDER BY stage`,
      [o.organizationId],
    );
    expect(stages.rows.map((r: { stage: number }) => r.stage)).toEqual([1, 2]);
    expect(stages.rows.every((r: { invoice_id: string }) => r.invoice_id === old.id)).toBe(true);
    expect(fresh.id).not.toBe(old.id);
    // The unique stage record also stops a duplicate at the database.
    await expect(
      db.query(
        `INSERT INTO payment_reminders (organization_id, invoice_id, customer_id, kind, stage, recipient, open_amount, currency_code, days_overdue, sent_at)
         SELECT organization_id, invoice_id, customer_id, 'auto', 1, recipient, open_amount, currency_code, days_overdue, now()
           FROM payment_reminders WHERE organization_id = $1 AND stage = 1 LIMIT 1`,
        [o.organizationId],
      ),
    ).rejects.toThrow(/payment_reminders_auto_once_idx/);
    // Overlapping runs after the maximum send nothing more.
    await Promise.all([ctx.services.reminders.runAuto(), ctx.services.reminders.runAuto()]);
    expect(await ownAuto()).toBe(2);
    const total = await db.query(
      `SELECT count(*)::int AS n FROM payment_reminders WHERE organization_id = $1`,
      [o.organizationId],
    );
    expect(total.rows[0].n).toBe(2);
  });

  it('needs the right permissions and isolates tenants', async () => {
    const o = await salesOrg();
    const overdue = await issuedInvoice(o, shift(todayIso(), -9));
    const member = await joinWithRole(ctx, o.owner, 'Member');
    expect((await member.client.get('/sales/reminders/overdue')).status).toBe(403);
    expect(
      (await member.client.post(`/sales/reminders/invoices/${overdue.id}/send`, {})).status,
    ).toBe(403);
    await o.owner.post('/organizations/current/roles', {
      name: 'Reminder viewer',
      permissionKeys: ['payment_reminders.view'],
    });
    const viewer = await joinWithRole(ctx, o.owner, 'Reminder viewer');
    expect((await viewer.client.get('/sales/reminders/overdue')).status).toBe(200);
    expect(
      (await viewer.client.post(`/sales/reminders/invoices/${overdue.id}/send`, {})).status,
    ).toBe(403);
    expect(
      (
        await viewer.client.put('/sales/reminders/settings', {
          version: 0,
          autoEnabled: true,
          firstAfterDays: 1,
          repeatEveryDays: 1,
          maxReminders: 1,
        })
      ).status,
    ).toBe(403);
    const other = await salesOrg();
    expect((await other.owner.get('/sales/reminders/overdue')).body.data).toEqual([]);
    expect(
      (await other.owner.post(`/sales/reminders/invoices/${overdue.id}/send`, {})).status,
    ).toBe(404);
  });
});

const orderBody = (o: SalesOrg, extra: object = {}) => ({
  customerId: o.customerId,
  orderDate: todayIso(),
  reference: 'PO-5521',
  lines: [
    { itemId: o.itemId, quantity: '10', unitPrice: '100' },
    { description: 'Setup', quantity: '1', unitPrice: '250' },
  ],
  ...extra,
});

async function confirmedOrder(o: SalesOrg) {
  const created = await o.owner.post('/sales/orders', orderBody(o));
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const confirmed = await o.owner.post(`/sales/orders/${created.body.data.id}/confirm`, {
    version: created.body.data.version,
  });
  expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
  return confirmed.body.data;
}

describe('sales orders', () => {
  it('creates, validates, edits drafts and freezes confirmed orders', async () => {
    const o = await salesOrg();
    const created = await o.owner.post('/sales/orders', orderBody(o));
    expect(created.body.data).toMatchObject({
      number: 'SO-00001',
      status: 'DRAFT',
      netTotal: '1250',
    });
    for (const bad of [
      { customerId: o.itemId },
      { expectedDate: shift(todayIso(), -3) },
      { lines: [] },
      { orderDate: 'x' },
      { extra: 1 },
    ]) {
      expect(
        (await o.owner.post('/sales/orders', orderBody(o, bad))).status,
        JSON.stringify(bad),
      ).toBe(400);
    }
    const edited = await o.owner.put(`/sales/orders/${created.body.data.id}`, {
      ...orderBody(o, { memo: 'Edited' }),
      version: created.body.data.version,
    });
    expect(edited.body.data.memo).toBe('Edited');
    const confirmed = await o.owner.post(`/sales/orders/${created.body.data.id}/confirm`, {
      version: edited.body.data.version,
    });
    expect(confirmed.body.data.status).toBe('CONFIRMED');
    expect(
      (
        await o.owner.put(`/sales/orders/${created.body.data.id}`, {
          ...orderBody(o),
          version: confirmed.body.data.version,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await o.owner.delete(
          `/sales/orders/${created.body.data.id}?version=${confirmed.body.data.version}`,
        )
      ).status,
    ).toBe(409);
    await expect(
      db.query(`UPDATE sales_order_lines SET quantity = 99 WHERE order_id = $1`, [
        created.body.data.id,
      ]),
    ).rejects.toThrow(/not a draft/);
    const draft = await o.owner.post('/sales/orders', orderBody(o));
    expect(
      (
        await o.owner.delete(
          `/sales/orders/${draft.body.data.id}?version=${draft.body.data.version}`,
        )
      ).status,
    ).toBe(200);
  });

  it('invoices in parts, never beyond the ordered quantity, and releases a deleted draft', async () => {
    const o = await salesOrg();
    const order = await confirmedOrder(o);
    const first = await o.owner.post(`/sales/orders/${order.id}/invoice`, {
      version: order.version,
      lines: [{ lineNo: 1, quantity: '4' }],
    });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const invoice = (await o.owner.get(`/sales/invoices/${first.body.data.invoiceId}`)).body.data;
    expect(invoice).toMatchObject({ status: 'DRAFT', reference: order.number, total: '400.00' });
    let current = (await o.owner.get(`/sales/orders/${order.id}`)).body.data;
    expect(current.status).toBe('PARTIALLY_INVOICED');
    expect(current.lines[0]).toMatchObject({ invoiced: '4', remaining: '6' });
    const tooMuch = await o.owner.post(`/sales/orders/${order.id}/invoice`, {
      version: order.version,
      lines: [{ lineNo: 1, quantity: '7' }],
    });
    expect(tooMuch.status).toBe(400);
    expect(tooMuch.body.error.details.issues[0].message).toMatch(/Only 6/);
    expect(
      (
        await o.owner.post(`/sales/orders/${order.id}/invoice`, {
          version: order.version,
          lines: [{ lineNo: 9, quantity: '1' }],
        })
      ).status,
    ).toBe(400);
    // Cancelling is refused while quantity is invoiced.
    expect(
      (
        await o.owner.post(`/sales/orders/${order.id}/cancel`, {
          version: order.version,
          reason: 'x',
        })
      ).status,
    ).toBe(409);
    const rest = await o.owner.post(`/sales/orders/${order.id}/invoice`, {
      version: order.version,
    });
    expect(rest.status, JSON.stringify(rest.body)).toBe(200);
    current = (await o.owner.get(`/sales/orders/${order.id}`)).body.data;
    expect(current.status).toBe('INVOICED');
    expect(
      (await o.owner.post(`/sales/orders/${order.id}/invoice`, { version: order.version })).status,
    ).toBe(400); // nothing left
    // Deleting the first draft releases its 4 units.
    const del = await o.owner.delete(`/sales/invoices/${invoice.id}?version=${invoice.version}`);
    expect(del.status, JSON.stringify(del.body)).toBe(200);
    current = (await o.owner.get(`/sales/orders/${order.id}`)).body.data;
    expect(current.status).toBe('PARTIALLY_INVOICED');
    expect(current.lines[0]).toMatchObject({ invoiced: '6', remaining: '4' });
  });

  it('cannot be over-invoiced by two racing requests, and cancels only when untouched', async () => {
    const o = await salesOrg();
    const order = await confirmedOrder(o);
    const request = () =>
      o.owner.post(`/sales/orders/${order.id}/invoice`, {
        version: order.version,
        lines: [{ lineNo: 1, quantity: '8' }],
      });
    const results = await Promise.all([request(), request()]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    const current = (await o.owner.get(`/sales/orders/${order.id}`)).body.data;
    expect(current.lines[0]).toMatchObject({ invoiced: '8', remaining: '2' });
    const untouched = await confirmedOrder(o);
    expect(
      (
        await o.owner.post(`/sales/orders/${untouched.id}/cancel`, {
          version: untouched.version,
          reason: ' ',
        })
      ).status,
    ).toBe(400);
    const cancelled = await o.owner.post(`/sales/orders/${untouched.id}/cancel`, {
      version: untouched.version,
      reason: 'Customer withdrew',
    });
    expect(cancelled.body.data).toMatchObject({
      status: 'CANCELLED',
      cancelReason: 'Customer withdrew',
    });
    expect(
      (await o.owner.post(`/sales/orders/${untouched.id}/invoice`, { version: untouched.version }))
        .status,
    ).toBe(409);
    const journals = await db.query(
      `SELECT count(*)::int AS n FROM accounting_journal_entries WHERE organization_id = $1`,
      [o.organizationId],
    );
    expect(journals.rows[0].n).toBe(0);
  });

  it('needs sales_orders.invoice and invoices.create to invoice, and isolates tenants', async () => {
    const o = await salesOrg();
    const order = await confirmedOrder(o);
    await o.owner.post('/organizations/current/roles', {
      name: 'Order clerk',
      permissionKeys: ['sales_orders.view', 'sales_orders.create', 'sales_orders.invoice'],
    });
    const clerk = await joinWithRole(ctx, o.owner, 'Order clerk');
    expect((await clerk.client.get('/sales/orders')).status).toBe(200);
    expect(
      (await clerk.client.post(`/sales/orders/${order.id}/invoice`, { version: order.version }))
        .status,
    ).toBe(403); // no invoices.create
    const member = await joinWithRole(ctx, o.owner, 'Member');
    expect((await member.client.get('/sales/orders')).status).toBe(403);
    const other = await salesOrg();
    expect((await other.owner.get('/sales/orders')).body.data).toEqual([]);
    expect((await other.owner.get(`/sales/orders/${order.id}`)).status).toBe(404);
    expect(
      (await other.owner.post(`/sales/orders/${order.id}/confirm`, { version: 1 })).status,
    ).toBe(404);
  });
});

describe('invoice share links', () => {
  it('opens one issued invoice without a session, counts views, and exposes nothing else', async () => {
    const o = await salesOrg();
    const invoice = await issuedInvoice(o, todayIso(), '750');
    const created = await o.owner.post(`/sales/invoices/${invoice.id}/share-links`, {
      expiresInDays: 7,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.headers['cache-control']).toBe('no-store');
    const { token, url, id } = created.body.data;
    expect(url).toContain(`/p/invoice/${token}`);
    const anonymous = ctx.client();
    const view = await anonymous.get(`/public/invoices/${token}`);
    expect(view.status, JSON.stringify(view.body)).toBe(200);
    expect(view.headers['cache-control']).toBe('no-store');
    expect(view.body.data).toMatchObject({
      number: invoice.number,
      status: 'ISSUED',
      total: '750',
      amountDue: '750',
      customerName: 'Sun Island Resort',
      voided: false,
    });
    const text = JSON.stringify(view.body);
    for (const leak of [o.organizationId, invoice.id, o.customerId, o.customerEmail, 'journal']) {
      expect(text).not.toContain(leak);
    }
    await anonymous.get(`/public/invoices/${token}`);
    const links = (await o.owner.get(`/sales/invoices/${invoice.id}/share-links`)).body.data;
    expect(links[0]).toMatchObject({ id, status: 'active', viewCount: 2 });
    expect(JSON.stringify(links)).not.toContain(token);
    // The database holds only the hash.
    const stored = await db.query(`SELECT token_hash FROM invoice_share_links WHERE id = $1`, [id]);
    expect(stored.rows[0].token_hash).toBe(createHash('sha256').update(token).digest('hex'));
    const audit = await db.query(
      `SELECT metadata::text AS m FROM audit_events WHERE organization_id = $1 AND action LIKE 'invoice.share_link%'`,
      [o.organizationId],
    );
    expect(audit.rows.map((r: { m: string }) => r.m).join(' ')).not.toContain(token);
    // A paid invoice shows nothing due.
    const receipt = await o.owner.post('/sales/receipts', {
      customerId: o.customerId,
      receiptDate: todayIso(),
      amount: '750',
      allocations: [{ invoiceId: invoice.id, amount: '750' }],
    });
    expect(receipt.status).toBe(201);
    expect((await anonymous.get(`/public/invoices/${token}`)).body.data.amountDue).toBe('0');
  });

  it('answers every invalid, expired, revoked or foreign token the same way', async () => {
    const o = await salesOrg();
    const invoice = await issuedInvoice(o, todayIso());
    const link = (
      await o.owner.post(`/sales/invoices/${invoice.id}/share-links`, { expiresInDays: 1 })
    ).body.data;
    const anonymous = ctx.client();
    const missing = await anonymous.get(`/public/invoices/${'A'.repeat(43)}`);
    expect(missing.status).toBe(404);
    const garbage = await anonymous.get('/public/invoices/not-a-token-at-all-but-long-enough-xx');
    expect(garbage.status).toBe(404);
    expect(garbage.body).toEqual(
      expect.objectContaining({ error: expect.objectContaining({ code: 'NOT_FOUND' }) }),
    );
    expect(garbage.body.error.message).toBe(missing.body.error.message);
    const revoked = await o.owner.post(`/sales/share-links/${link.id}/revoke`, {});
    expect(revoked.body.data.status).toBe('revoked');
    const afterRevoke = await anonymous.get(`/public/invoices/${link.token}`);
    expect(afterRevoke.status).toBe(404);
    expect(afterRevoke.body.error.message).toBe(missing.body.error.message);
    expect((await o.owner.post(`/sales/share-links/${link.id}/revoke`, {})).status).toBe(409);
    await expect(
      db.query(`UPDATE invoice_share_links SET revoked_at = NULL WHERE id = $1`, [link.id]),
    ).rejects.toThrow();
    await expect(
      db.query(`DELETE FROM invoice_share_links WHERE id = $1`, [link.id]),
    ).rejects.toThrow(/never deleted/);
    // Expiry.
    const second = (
      await o.owner.post(`/sales/invoices/${invoice.id}/share-links`, { expiresInDays: 1 })
    ).body.data;
    expect((await anonymous.get(`/public/invoices/${second.token}`)).status).toBe(200);
    await db.query(`UPDATE invoice_share_links SET view_count = view_count WHERE id = $1`, [
      second.id,
    ]);
    ctx.clock.advance(2 * 86_400_000);
    try {
      expect((await anonymous.get(`/public/invoices/${second.token}`)).status).toBe(404);
    } finally {
      ctx.clock.advance(-2 * 86_400_000);
    }
  });

  it('only issued invoices can be shared, a voided one shows no amounts, and permissions apply', async () => {
    const o = await salesOrg();
    const draft = await o.owner.post('/sales/invoices', {
      customerId: o.customerId,
      invoiceDate: todayIso(),
      lines: [{ description: 'x', quantity: '1', unitPrice: '10' }],
    });
    expect(
      (await o.owner.post(`/sales/invoices/${draft.body.data.id}/share-links`, {})).status,
    ).toBe(409);
    const invoice = await issuedInvoice(o, todayIso(), '300');
    const link = (await o.owner.post(`/sales/invoices/${invoice.id}/share-links`, {})).body.data;
    expect(link.status).toBe('active');
    const voided = await o.owner.post(`/sales/invoices/${invoice.id}/void`, {
      version: invoice.version,
      reason: 'Wrong customer',
    });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    const view = await ctx.client().get(`/public/invoices/${link.token}`);
    expect(view.body.data).toMatchObject({ status: 'VOID', voided: true });
    expect(JSON.stringify(view.body)).not.toContain('300');
    const member = await joinWithRole(ctx, o.owner, 'Member');
    expect((await member.client.post(`/sales/invoices/${invoice.id}/share-links`, {})).status).toBe(
      403,
    );
    expect((await member.client.get(`/sales/invoices/${invoice.id}/share-links`)).status).toBe(403);
    const other = await salesOrg();
    expect((await other.owner.get(`/sales/invoices/${invoice.id}/share-links`)).status).toBe(404);
    expect((await other.owner.post(`/sales/share-links/${link.id}/revoke`, {})).status).toBe(404);
    expect((await other.owner.post(`/sales/invoices/${invoice.id}/share-links`, {})).status).toBe(
      404,
    );
  });

  it('rate limits the public read per address', async () => {
    const o = await salesOrg();
    const invoice = await issuedInvoice(o, todayIso());
    const link = (await o.owner.post(`/sales/invoices/${invoice.id}/share-links`, {})).body.data;
    const client = ctx.client('203.0.113.77');
    let limited = 0;
    for (let i = 0; i < 40; i += 1) {
      const res = await client.get(`/public/invoices/${link.token}`);
      if (res.status === 429) limited += 1;
    }
    expect(limited).toBeGreaterThan(0);
  });
});
