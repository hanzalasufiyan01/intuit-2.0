import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { occurrence } from '../src/modules/quotes/index.js';
import { joinWithRole, setUpAccountingOrg, type AccountingOrg } from './fixtures.js';
import { connectAs, createTestContext, type TestContext } from './helpers.js';

/**
 * Sales quotes and recurring invoice schedules (FP-28): the quote lifecycle and its single
 * conversion into a draft invoice, recurrence arithmetic without month-end drift, the background
 * run (catch-up, idempotency, end date, pausing on failure), permissions and tenant isolation.
 * Neither feature posts to the ledger. Real PostgreSQL.
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
  itemId: string;
}

async function salesOrg(): Promise<SalesOrg> {
  const org = await setUpAccountingOrg(ctx);
  const settings = await org.owner.put('/sales/settings', {
    version: 0,
    arAccountId: org.accounts['1130'],
    defaultRevenueAccountId: org.accounts['4100'],
    defaultDepositAccountId: org.accounts['1120'],
    defaultTaxCodeId: null,
    defaultTaxTreatment: 'no_tax',
    defaultPaymentTermsDays: 30,
  });
  expect(settings.status, JSON.stringify(settings.body)).toBe(200);
  const customer = await org.owner.post('/customers', {
    party: { kind: 'organization', displayName: 'Sun Island Resort' },
  });
  const item = await org.owner.post('/sales/items', {
    name: 'Monthly support',
    itemType: 'service',
    unitPrice: '500',
    revenueAccountId: org.accounts['4200'],
  });
  expect(item.status, JSON.stringify(item.body)).toBe(201);
  return { ...org, customerId: customer.body.data.id, itemId: item.body.data.id };
}

const quoteBody = (o: SalesOrg, extra: object = {}) => ({
  customerId: o.customerId,
  quoteDate: todayIso(),
  validUntil: shift(todayIso(), 30),
  reference: 'RFQ-7',
  memo: 'Annual support',
  lines: [
    { itemId: o.itemId, quantity: '2', unitPrice: '500' },
    { description: 'Setup', quantity: '1', unitPrice: '250.50' },
  ],
  ...extra,
});

async function newQuote(o: SalesOrg, extra: object = {}) {
  const res = await o.owner.post('/sales/quotes', quoteBody(o, extra));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data;
}

describe('recurrence arithmetic', () => {
  it('counts occurrences from the start date, clamping month ends without drift', () => {
    expect([0, 1, 2, 3].map((n) => occurrence('2026-01-31', 'monthly', n))).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
    ]);
    expect(occurrence('2024-01-31', 'monthly', 1)).toBe('2024-02-29'); // leap year
    expect([0, 1, 2].map((n) => occurrence('2026-11-30', 'quarterly', n))).toEqual([
      '2026-11-30',
      '2027-02-28',
      '2027-05-30',
    ]);
    expect([0, 1, 2, 3, 4].map((n) => occurrence('2024-02-29', 'yearly', n))).toEqual([
      '2024-02-29',
      '2025-02-28',
      '2026-02-28',
      '2027-02-28',
      '2028-02-29',
    ]);
    expect([0, 1, 2].map((n) => occurrence('2026-12-28', 'weekly', n))).toEqual([
      '2026-12-28',
      '2027-01-04',
      '2027-01-11',
    ]);
    expect(() => occurrence('2026-01-01', 'monthly', -1)).toThrow(RangeError);
  });
});

describe('quotes', () => {
  it('creates a numbered draft with computed totals, validates, and replays an idempotent create', async () => {
    const o = await salesOrg();
    const quote = await newQuote(o);
    expect(quote).toMatchObject({
      number: 'QUO-00001',
      status: 'DRAFT',
      netTotal: '1250.5',
      reference: 'RFQ-7',
    });
    expect(quote.lines).toHaveLength(2);
    expect(quote.lines[0]).toMatchObject({ description: 'Monthly support', netAmount: '1000' });
    for (const bad of [
      { customerId: randomUUID() },
      { validUntil: shift(todayIso(), -1) },
      { quoteDate: 'x' },
      { lines: [] },
      { lines: [{ quantity: '0', unitPrice: '1', description: 'x' }] },
      { lines: [{ quantity: '1', unitPrice: '1' }] }, // no description and no item
      { lines: [{ itemId: randomUUID(), quantity: '1', unitPrice: '1' }] },
      { extra: true },
    ]) {
      expect(
        (await o.owner.post('/sales/quotes', quoteBody(o, bad))).status,
        JSON.stringify(bad),
      ).toBe(400);
    }
    const key = randomUUID();
    const body = quoteBody(o);
    const first = await o.owner.post('/sales/quotes', body, { 'idempotency-key': key });
    const replay = await o.owner.post('/sales/quotes', body, { 'idempotency-key': key });
    expect(replay.body.data.id).toBe(first.body.data.id);
    expect((await o.owner.get('/sales/quotes')).body.data).toHaveLength(2);
  });

  it('runs draft, sent, accepted and converted, converting exactly once into a draft invoice', async () => {
    const o = await salesOrg();
    const quote = await newQuote(o);
    // Out-of-order steps are refused.
    expect(
      (await o.owner.post(`/sales/quotes/${quote.id}/accept`, { version: quote.version })).status,
    ).toBe(409);
    expect(
      (await o.owner.post(`/sales/quotes/${quote.id}/convert`, { version: quote.version })).status,
    ).toBe(409);
    const edited = await o.owner.put(`/sales/quotes/${quote.id}`, {
      ...quoteBody(o, { memo: 'Edited' }),
      version: quote.version,
    });
    expect(edited.body.data.memo).toBe('Edited');
    const sent = await o.owner.post(`/sales/quotes/${quote.id}/send`, {
      version: edited.body.data.version,
    });
    expect(sent.body.data.status).toBe('SENT');
    // A sent quote is frozen: no edit, no delete.
    expect(
      (
        await o.owner.put(`/sales/quotes/${quote.id}`, {
          ...quoteBody(o),
          version: sent.body.data.version,
        })
      ).status,
    ).toBe(409);
    expect(
      (await o.owner.delete(`/sales/quotes/${quote.id}?version=${sent.body.data.version}`)).status,
    ).toBe(409);
    const accepted = await o.owner.post(`/sales/quotes/${quote.id}/accept`, {
      version: sent.body.data.version,
    });
    expect(accepted.body.data.status).toBe('ACCEPTED');
    const converted = await o.owner.post(`/sales/quotes/${quote.id}/convert`, {
      version: accepted.body.data.version,
    });
    expect(converted.status, JSON.stringify(converted.body)).toBe(200);
    expect(converted.body.data.quote.status).toBe('CONVERTED');
    const invoice = (await o.owner.get(`/sales/invoices/${converted.body.data.invoiceId}`)).body
      .data;
    expect(invoice).toMatchObject({ status: 'DRAFT', reference: quote.number, total: '1250.50' });
    expect(invoice.lines).toHaveLength(2);
    // Once only: a repeat, and a stale version, are refused; nothing was posted.
    expect(
      (
        await o.owner.post(`/sales/quotes/${quote.id}/convert`, {
          version: converted.body.data.quote.version,
        })
      ).status,
    ).toBe(409);
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM accounting_journal_entries WHERE organization_id = $1`,
      [o.organizationId],
    );
    expect(rows[0].n).toBe(0);
    // The database also refuses to reuse the invoice for another quote or to reopen the quote.
    await expect(
      db.query(`UPDATE sales_quotes SET status = 'DRAFT' WHERE id = $1`, [quote.id]),
    ).rejects.toThrow(/final/);
    const audit = await db.query(
      `SELECT action FROM audit_events WHERE organization_id = $1 AND action LIKE 'quote.%' ORDER BY occurred_at, id`,
      [o.organizationId],
    );
    expect(audit.rows.map((r: { action: string }) => r.action)).toEqual([
      'quote.created',
      'quote.updated',
      'quote.sent',
      'quote.accepted',
      'quote.converted',
    ]);
  });

  it('records a decline with a reason, deletes drafts, and refuses expired quotes', async () => {
    const o = await salesOrg();
    const quote = await newQuote(o);
    const sent = await o.owner.post(`/sales/quotes/${quote.id}/send`, { version: quote.version });
    expect(
      (
        await o.owner.post(`/sales/quotes/${quote.id}/decline`, {
          version: sent.body.data.version,
          reason: ' ',
        })
      ).status,
    ).toBe(400);
    const declined = await o.owner.post(`/sales/quotes/${quote.id}/decline`, {
      version: sent.body.data.version,
      reason: 'Too expensive',
    });
    expect(declined.body.data).toMatchObject({
      status: 'DECLINED',
      declineReason: 'Too expensive',
    });
    expect(
      (
        await o.owner.post(`/sales/quotes/${quote.id}/accept`, {
          version: declined.body.data.version,
        })
      ).status,
    ).toBe(409);
    const draft = await newQuote(o);
    expect(
      (await o.owner.delete(`/sales/quotes/${draft.id}?version=${draft.version}`)).status,
    ).toBe(200);
    expect((await o.owner.get(`/sales/quotes/${draft.id}`)).status).toBe(404);
    // A quote that is already past its validity date cannot be sent.
    const past = await o.owner.post(
      '/sales/quotes',
      quoteBody(o, { quoteDate: shift(todayIso(), -40), validUntil: shift(todayIso(), -10) }),
    );
    expect(past.status).toBe(201);
    expect(
      (
        await o.owner.post(`/sales/quotes/${past.body.data.id}/send`, {
          version: past.body.data.version,
        })
      ).status,
    ).toBe(409);
    // A quote sent in time reads as expired afterwards and cannot be converted.
    const soon = await newQuote(o, { quoteDate: todayIso(), validUntil: todayIso() });
    const soonSent = await o.owner.post(`/sales/quotes/${soon.id}/send`, { version: soon.version });
    const soonAccepted = await o.owner.post(`/sales/quotes/${soon.id}/accept`, {
      version: soonSent.body.data.version,
    });
    expect(soonAccepted.status).toBe(200);
    ctx.clock.advance(2 * 86_400_000);
    // Keep the owner's session alive across the jump (sessions also idle out).
    await db.query(
      `UPDATE sessions SET last_seen_at = $1
        WHERE user_id = (SELECT id FROM users WHERE lower(email) = lower($2))`,
      [new Date(ctx.clock.now().getTime() - 60_000), o.ownerEmail],
    );
    try {
      expect((await o.owner.get(`/sales/quotes/${soon.id}`)).body.data.status).toBe('EXPIRED');
      expect(
        (
          await o.owner.post(`/sales/quotes/${soon.id}/convert`, {
            version: soonAccepted.body.data.version,
          })
        ).status,
      ).toBe(409);
    } finally {
      ctx.clock.advance(-2 * 86_400_000);
    }
  });

  it('needs the right permissions and isolates tenants', async () => {
    const o = await salesOrg();
    const quote = await newQuote(o);
    const member = await joinWithRole(ctx, o.owner, 'Member');
    expect((await member.client.get('/sales/quotes')).status).toBe(403);
    expect((await member.client.post('/sales/quotes', quoteBody(o))).status).toBe(403);
    await o.owner.post('/organizations/current/roles', {
      name: 'Quote clerk',
      permissionKeys: ['quotes.view', 'quotes.create', 'customers.view'],
    });
    const clerk = await joinWithRole(ctx, o.owner, 'Quote clerk');
    expect((await clerk.client.get('/sales/quotes')).status).toBe(200);
    const sent = await clerk.client.post(`/sales/quotes/${quote.id}/send`, {
      version: quote.version,
    });
    const accepted = await clerk.client.post(`/sales/quotes/${quote.id}/accept`, {
      version: sent.body.data.version,
    });
    expect(accepted.status).toBe(200);
    // The clerk cannot convert: no quotes.convert, and none of invoices.create.
    expect(
      (
        await clerk.client.post(`/sales/quotes/${quote.id}/convert`, {
          version: accepted.body.data.version,
        })
      ).status,
    ).toBe(403);
    await o.owner.post('/organizations/current/roles', {
      name: 'Converter',
      permissionKeys: ['quotes.view', 'quotes.convert'],
    });
    const converter = await joinWithRole(ctx, o.owner, 'Converter');
    expect(
      (
        await converter.client.post(`/sales/quotes/${quote.id}/convert`, {
          version: accepted.body.data.version,
        })
      ).status,
    ).toBe(403);
    const other = await salesOrg();
    expect((await other.owner.get('/sales/quotes')).body.data).toEqual([]);
    expect((await other.owner.get(`/sales/quotes/${quote.id}`)).status).toBe(404);
    expect(
      (await other.owner.post(`/sales/quotes/${quote.id}/accept`, { version: 1 })).status,
    ).toBe(404);
    expect(
      (await other.owner.post('/sales/quotes', quoteBody(other, { customerId: o.customerId })))
        .status,
    ).toBe(400);
  });
});

/** Pauses every other organization's schedules so a run only touches the test's own. */
async function isolateSchedules(organizationId: string) {
  await db.query(
    `UPDATE recurring_invoice_schedules SET status = 'PAUSED' WHERE organization_id <> $1 AND status = 'ACTIVE'`,
    [organizationId],
  );
}

const scheduleBody = (o: SalesOrg, extra: object = {}) => ({
  name: 'Monthly support',
  customerId: o.customerId,
  frequency: 'monthly',
  startDate: todayIso(),
  lines: [{ itemId: o.itemId, quantity: '1', unitPrice: '500' }],
  ...extra,
});

async function newSchedule(o: SalesOrg, extra: object = {}) {
  const res = await o.owner.post('/sales/recurring-invoices', scheduleBody(o, extra));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data;
}

describe('recurring invoices', () => {
  it('generates one draft per occurrence on demand, advancing without drift, and never posts', async () => {
    const o = await salesOrg();
    const schedule = await newSchedule(o, { startDate: '2026-01-31', paymentTermsDays: 14 });
    expect(schedule).toMatchObject({ status: 'ACTIVE', nextRunDate: '2026-01-31', runCount: 0 });
    let current = schedule;
    const dates: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const run = await o.owner.post(`/sales/recurring-invoices/${current.id}/run-now`, {
        version: current.version,
      });
      expect(run.status, JSON.stringify(run.body)).toBe(200);
      current = run.body.data.schedule;
      dates.push(current.nextRunDate);
      const invoice = (await o.owner.get(`/sales/invoices/${run.body.data.invoiceId}`)).body.data;
      expect(invoice.status).toBe('DRAFT');
      expect(invoice.total).toBe('500.00');
    }
    expect(dates).toEqual(['2026-02-28', '2026-03-31', '2026-04-30']);
    expect(current.runs.map((r: { runDate: string }) => r.runDate)).toEqual([
      '2026-03-31',
      '2026-02-28',
      '2026-01-31',
    ]);
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM accounting_journal_entries WHERE organization_id = $1`,
      [o.organizationId],
    );
    expect(rows[0].n).toBe(0);
    // The database makes a run date unique per schedule and the run record immutable.
    await expect(
      db.query(
        `INSERT INTO recurring_invoice_runs (organization_id, schedule_id, run_date, invoice_id, created_at)
         VALUES ($1, $2, '2026-01-31', $3, now())`,
        [o.organizationId, current.id, randomUUID()],
      ),
    ).rejects.toThrow(/recurring_invoice_runs_once/);
    await expect(
      db.query(`DELETE FROM recurring_invoice_runs WHERE schedule_id = $1`, [current.id]),
    ).rejects.toThrow();
  });

  it('catches up missed periods in the background run, once, and ends at the end date', async () => {
    const o = await salesOrg();
    await isolateSchedules(o.organizationId);
    const start = shift(todayIso(), -75); // roughly two and a half months back, weekly below
    const weekly = await newSchedule(o, { name: 'Weekly', frequency: 'weekly', startDate: start });
    const created = await ctx.services.recurring.runDue();
    // From 75 days ago to today, every 7 days: occurrences 0..10 are on or before today.
    expect(created).toBe(11);
    const detail = (await o.owner.get(`/sales/recurring-invoices/${weekly.id}`)).body.data;
    expect(detail.runCount).toBe(11);
    expect(detail.nextRunDate).toBe(shift(start, 77));
    expect(detail.runs).toHaveLength(11);
    // A second run does nothing: it is not due again.
    await isolateSchedules(o.organizationId);
    expect(await ctx.services.recurring.runDue()).toBe(0);
    // An end date stops the schedule after its last occurrence.
    const limited = await newSchedule(o, {
      name: 'Limited',
      startDate: shift(todayIso(), -40),
      endDate: shift(todayIso(), -20),
    });
    await isolateSchedules(o.organizationId);
    await db.query(`UPDATE recurring_invoice_schedules SET status = 'PAUSED' WHERE id = $1`, [
      weekly.id,
    ]);
    expect(await ctx.services.recurring.runDue()).toBe(1); // only the start date is before the end date
    const done = (await o.owner.get(`/sales/recurring-invoices/${limited.id}`)).body.data;
    expect(done.status).toBe('ENDED');
  });

  it('pauses, resumes and ends; refuses edits that would rewrite history; needs invoices.create', async () => {
    const o = await salesOrg();
    const schedule = await newSchedule(o);
    const paused = await o.owner.post(`/sales/recurring-invoices/${schedule.id}/pause`, {
      version: schedule.version,
    });
    expect(paused.body.data.status).toBe('PAUSED');
    expect(
      (
        await o.owner.post(`/sales/recurring-invoices/${schedule.id}/pause`, {
          version: paused.body.data.version,
        })
      ).status,
    ).toBe(409);
    await isolateSchedules(o.organizationId);
    expect(await ctx.services.recurring.runDue()).toBe(0); // paused schedules are not run
    const resumed = await o.owner.post(`/sales/recurring-invoices/${schedule.id}/resume`, {
      version: paused.body.data.version,
    });
    const run = await o.owner.post(`/sales/recurring-invoices/${schedule.id}/run-now`, {
      version: resumed.body.data.version,
    });
    expect(run.status).toBe(200);
    const after = run.body.data.schedule;
    const changed = await o.owner.put(`/sales/recurring-invoices/${schedule.id}`, {
      ...scheduleBody(o, { frequency: 'weekly' }),
      version: after.version,
    });
    expect(changed.status).toBe(400); // frequency is fixed once invoices exist
    const renamed = await o.owner.put(`/sales/recurring-invoices/${schedule.id}`, {
      ...scheduleBody(o, { name: 'Renamed' }),
      version: after.version,
    });
    expect(renamed.body.data.name).toBe('Renamed');
    const ended = await o.owner.post(`/sales/recurring-invoices/${schedule.id}/end`, {
      version: renamed.body.data.version,
    });
    expect(ended.body.data.status).toBe('ENDED');
    expect(
      (
        await o.owner.post(`/sales/recurring-invoices/${schedule.id}/run-now`, {
          version: ended.body.data.version,
        })
      ).status,
    ).toBe(409);
    // Without invoices.create a person can neither create nor run a schedule.
    await o.owner.post('/organizations/current/roles', {
      name: 'Scheduler',
      permissionKeys: ['recurring_invoices.view', 'recurring_invoices.manage'],
    });
    const scheduler = await joinWithRole(ctx, o.owner, 'Scheduler');
    expect((await scheduler.client.post('/sales/recurring-invoices', scheduleBody(o))).status).toBe(
      403,
    );
    expect((await scheduler.client.get('/sales/recurring-invoices')).status).toBe(200);
    const member = await joinWithRole(ctx, o.owner, 'Member');
    expect((await member.client.get('/sales/recurring-invoices')).status).toBe(403);
    const other = await salesOrg();
    expect((await other.owner.get(`/sales/recurring-invoices/${schedule.id}`)).status).toBe(404);
  });

  it('pauses a schedule with the reason when the person it acts for can no longer create invoices', async () => {
    const o = await salesOrg();
    const role = await o.owner.post('/organizations/current/roles', {
      name: 'Biller',
      permissionKeys: [
        'recurring_invoices.view',
        'recurring_invoices.manage',
        'invoices.create',
        'customers.view',
      ],
    });
    expect(role.status, JSON.stringify(role.body)).toBe(201);
    const biller = await joinWithRole(ctx, o.owner, 'Biller');
    const created = await biller.client.post(
      '/sales/recurring-invoices',
      scheduleBody(o, { startDate: shift(todayIso(), -3) }),
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const updated = await o.owner.put(`/organizations/current/roles/${role.body.data.id}`, {
      name: 'Biller',
      permissionKeys: ['recurring_invoices.view', 'recurring_invoices.manage', 'customers.view'],
    });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    await isolateSchedules(o.organizationId);
    expect(await ctx.services.recurring.runDue()).toBe(0);
    const detail = (await o.owner.get(`/sales/recurring-invoices/${created.body.data.id}`)).body
      .data;
    expect(detail.status).toBe('PAUSED');
    expect(detail.lastError).toBeTruthy();
    expect(detail.runs).toEqual([]);
    const audit = await db.query(
      `SELECT action FROM audit_events WHERE organization_id = $1 AND action = 'recurring_invoice.paused_after_failure'`,
      [o.organizationId],
    );
    expect(audit.rows).toHaveLength(1);
  });
});

describe('concurrent operations', () => {
  it('converts a quote once when two requests race', async () => {
    const o = await salesOrg();
    const quote = await newQuote(o);
    const sent = await o.owner.post(`/sales/quotes/${quote.id}/send`, { version: quote.version });
    const accepted = await o.owner.post(`/sales/quotes/${quote.id}/accept`, {
      version: sent.body.data.version,
    });
    const body = { version: accepted.body.data.version };
    const results = await Promise.all([
      o.owner.post(`/sales/quotes/${quote.id}/convert`, body),
      o.owner.post(`/sales/quotes/${quote.id}/convert`, body),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const invoices = await db.query(
      `SELECT count(*)::int AS n FROM sales_invoices WHERE organization_id = $1`,
      [o.organizationId],
    );
    expect(invoices.rows[0].n).toBe(1);
  });

  it('never generates the same occurrence twice when two background runs overlap', async () => {
    const o = await salesOrg();
    await isolateSchedules(o.organizationId);
    const start = shift(todayIso(), -21);
    const schedule = await newSchedule(o, {
      name: 'Overlap',
      frequency: 'weekly',
      startDate: start,
    });
    const [a, b] = await Promise.all([
      ctx.services.recurring.runDue(),
      ctx.services.recurring.runDue(),
    ]);
    expect(a + b).toBe(4); // occurrences 0..3 are on or before today
    const detail = (await o.owner.get(`/sales/recurring-invoices/${schedule.id}`)).body.data;
    expect(detail.runCount).toBe(4);
    expect(detail.runs).toHaveLength(4);
    const invoices = await db.query(
      `SELECT count(*)::int AS n FROM sales_invoices WHERE organization_id = $1`,
      [o.organizationId],
    );
    expect(invoices.rows[0].n).toBe(4);
  });

  it('two run-now requests on one version create one draft', async () => {
    const o = await salesOrg();
    const schedule = await newSchedule(o);
    const results = await Promise.all([
      o.owner.post(`/sales/recurring-invoices/${schedule.id}/run-now`, {
        version: schedule.version,
      }),
      o.owner.post(`/sales/recurring-invoices/${schedule.id}/run-now`, {
        version: schedule.version,
      }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const invoices = await db.query(
      `SELECT count(*)::int AS n FROM sales_invoices WHERE organization_id = $1`,
      [o.organizationId],
    );
    expect(invoices.rows[0].n).toBe(1);
  });
});
