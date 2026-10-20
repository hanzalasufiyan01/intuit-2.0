import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DOMAIN_PUBLIC_EVENT_TYPES,
  PUBLIC_EVENT_TYPES,
  publishPublicEvent,
} from '../src/modules/public-events/index.js';
import { OutboxDispatcher } from '../src/modules/outbox/index.js';
import { inTransaction } from '../src/application/unit-of-work.js';
import { joinWithRole, setUpAccountingOrg, type AccountingOrg } from './fixtures.js';
import { connectAs, createTestContext, type TestContext } from './helpers.js';

/**
 * ADR 0011 Step 5: public event EMISSION only. Each eligible domain operation inserts one outbox
 * row (`public.<type>`) in its own transaction; nothing is delivered, subscribed or fanned out.
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

const sql = (text: string, params: unknown[] = []) => owner.query(text, params);

const FROZEN_CATALOG = [
  'customer.created',
  'customer.updated',
  'customer.archived',
  'vendor.created',
  'vendor.updated',
  'vendor.archived',
  'item.created',
  'item.updated',
  'item.archived',
  'invoice.issued',
  'invoice.voided',
  'credit_note.issued',
  'receipt.recorded',
  'receipt.voided',
  'customer_refund.recorded',
  'customer_refund.voided',
  'bill.posted',
  'bill.voided',
  'vendor_credit.posted',
  'vendor_credit.voided',
  'vendor_payment.recorded',
  'vendor_payment.voided',
  'vendor_refund.recorded',
  'vendor_refund.voided',
  'expense_claim.posted',
  'expense_claim.voided',
  'webhook.ping',
];

const TABLE: Record<string, string> = {
  customer: 'customers',
  vendor: 'vendors',
  item: 'sales_items',
  invoice: 'sales_invoices',
  credit_note: 'sales_credit_notes',
  receipt: 'sales_receipts',
  customer_refund: 'sales_refunds',
  bill: 'purchases_bills',
  vendor_credit: 'purchases_vendor_credits',
  vendor_payment: 'purchases_payments',
  vendor_refund: 'purchases_refunds',
  expense_claim: 'expense_claims',
};

interface Row {
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  organization_id: string;
  payload: {
    id: string;
    type: string;
    api_version: string;
    occurred_at: string;
    organization_id: string;
    resource: { type: string; id: string; version?: number };
    data: { object_type: string; object_id: string; url: string | null };
  };
  status: string;
}

/** The public outbox rows of an organization, oldest first. */
async function outbox(organizationId: string): Promise<Row[]> {
  const res = await sql(
    `SELECT event_type, aggregate_type, aggregate_id, organization_id, payload, status
       FROM outbox_events
      WHERE organization_id = $1 AND event_type LIKE 'public.%'
      ORDER BY created_at, id`,
    [organizationId],
  );
  return res.rows;
}

/** Runs `act` and returns the public events it produced. */
async function emitted(o: AccountingOrg, act: () => Promise<unknown>): Promise<Row[]> {
  const before = (await outbox(o.organizationId)).length;
  await act();
  return (await outbox(o.organizationId)).slice(before);
}
const types = (rows: Row[]) => rows.map((r) => r.payload.type).sort();

/**
 * Every emitted event has the frozen shape; its resource version is the version the change
 * committed (the resource's current version, unless a later event of the batch changed it again).
 */
async function expectContract(o: AccountingOrg, rows: Row[]) {
  for (const [index, row] of rows.entries()) {
    const p = row.payload;
    expect(Object.keys(p).sort()).toEqual(
      ['api_version', 'data', 'id', 'occurred_at', 'organization_id', 'resource', 'type'].sort(),
    );
    expect(p.id).toMatch(/^evt_[0-9a-f-]{36}$/);
    expect(p.id).not.toBe(p.resource.id);
    // The thin data form, and nothing else.
    expect(Object.keys(p.data).sort()).toEqual(['object_id', 'object_type', 'url']);
    expect(p.data.object_type).toBe(p.resource.type);
    expect(p.data.object_id).toBe(p.resource.id);
    const readable: Record<string, string> = {
      customer: 'customers',
      vendor: 'vendors',
      invoice: 'invoices',
      bill: 'bills',
    };
    expect(p.data.url).toBe(
      readable[p.resource.type] ? `/public/v1/${readable[p.resource.type]}/${p.resource.id}` : null,
    );
    expect(p.api_version).toBe('v1');
    expect(p.organization_id).toBe(o.organizationId);
    expect(new Date(p.occurred_at).toISOString()).toBe(p.occurred_at);
    expect(row.event_type).toBe(`public.${p.type}`);
    expect(p.type.startsWith(`${p.resource.type}.`)).toBe(true);
    expect(row.aggregate_type).toBe(p.resource.type);
    expect(row.aggregate_id).toBe(p.resource.id);
    expect(row.organization_id).toBe(o.organizationId);
    expect(Object.keys(p.resource).sort()).toEqual(['id', 'type', 'version']);
    const table = TABLE[p.resource.type]!;
    const current = await sql(`SELECT version FROM ${table} WHERE id = $1`, [p.resource.id]);
    expect(current.rows, `${p.type} resource exists`).toHaveLength(1);
    const later = rows.slice(index + 1).some((r) => r.payload.resource.id === p.resource.id);
    if (later)
      expect(p.resource.version, `${p.type} version`).toBeLessThan(current.rows[0].version);
    else expect(p.resource.version, `${p.type} version`).toBe(current.rows[0].version);
  }
}

async function bothSettings(): Promise<AccountingOrg> {
  const org = await setUpAccountingOrg(ctx);
  const sales = await org.owner.put('/sales/settings', {
    version: 0,
    arAccountId: org.accounts['1130'],
    defaultRevenueAccountId: org.accounts['4100'],
    defaultDepositAccountId: org.accounts['1120'],
    defaultTaxCodeId: null,
    defaultTaxTreatment: 'no_tax',
    defaultPaymentTermsDays: 30,
  });
  expect(sales.status, JSON.stringify(sales.body)).toBe(200);
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
  return org;
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

describe('public event catalog', () => {
  it('is exactly the frozen 27 types; domain operations can emit all but webhook.ping', () => {
    expect([...PUBLIC_EVENT_TYPES].sort()).toEqual([...FROZEN_CATALOG].sort());
    expect(PUBLIC_EVENT_TYPES).toHaveLength(27);
    expect([...DOMAIN_PUBLIC_EVENT_TYPES].sort()).toEqual(
      FROZEN_CATALOG.filter((t) => t !== 'webhook.ping').sort(),
    );
    // No journal-level or other excluded family exists.
    expect(PUBLIC_EVENT_TYPES.some((t) => /journal|accounting|paid|approval|period/.test(t))).toBe(
      false,
    );
  });

  it('refuses to publish a type outside the catalog', async () => {
    const o = await bothSettings();
    await expect(
      inTransaction(ctx.database.db, { organizationId: o.organizationId }, (tx) =>
        publishPublicEvent(
          tx,
          {
            type: 'journal.posted' as never,
            organizationId: o.organizationId,
            resourceId: randomUUID(),
          },
          new Date(),
        ),
      ),
    ).rejects.toThrow(/Unknown public event type/);
    expect(await outbox(o.organizationId)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Customers, vendors, items
// ---------------------------------------------------------------------------

describe('master data events', () => {
  it('emits created, updated and archived for customers, vendors and items (restore is an update)', async () => {
    const o = await bothSettings();
    const cases = [
      {
        resource: 'customer',
        create: () =>
          o.owner.post('/customers', { party: { kind: 'organization', displayName: 'Acme' } }),
        update: (r: { id: string; version: number }) =>
          o.owner.patch(`/customers/${r.id}`, { version: r.version, paymentTermsDays: 10 }),
        status: (r: { id: string }, action: string, version: number) =>
          o.owner.post(`/customers/${r.id}/${action}`, { version }),
      },
      {
        resource: 'vendor',
        create: () =>
          o.owner.post('/vendors', { party: { kind: 'organization', displayName: 'Supplier' } }),
        update: (r: { id: string; version: number }) =>
          o.owner.patch(`/vendors/${r.id}`, { version: r.version, paymentTermsDays: 10 }),
        status: (r: { id: string }, action: string, version: number) =>
          o.owner.post(`/vendors/${r.id}/${action}`, { version }),
      },
      {
        resource: 'item',
        create: () => o.owner.post('/sales/items', { name: 'Reef pass', itemType: 'service' }),
        update: (r: { id: string; version: number }) =>
          o.owner.patch(`/sales/items/${r.id}`, { version: r.version, description: 'Changed' }),
        status: (r: { id: string }, action: string, version: number) =>
          o.owner.post(`/sales/items/${r.id}/${action}`, { version }),
      },
    ];
    for (const c of cases) {
      let created: any;
      const made = await emitted(o, async () => {
        const res = await c.create();
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        created = res.body.data;
      });
      expect(types(made), c.resource).toEqual([`${c.resource}.created`]);
      expect(made[0]!.payload.resource.id).toBe(created.id);
      await expectContract(o, made);

      let updated: any;
      const changed = await emitted(o, async () => {
        const res = await c.update(created);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        updated = res.body.data;
      });
      expect(types(changed), c.resource).toEqual([`${c.resource}.updated`]);
      expect(changed[0]!.payload.resource.version).toBe(updated.version);
      await expectContract(o, changed);

      // An update that changes nothing is not an event.
      const noop = await emitted(o, async () => {
        const res = await c.update(updated);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
      });
      expect(noop, `${c.resource} no-op`).toEqual([]);

      let archived: any;
      const archive = await emitted(o, async () => {
        const res = await c.status(updated, 'archive', updated.version);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        archived = res.body.data;
      });
      expect(types(archive), c.resource).toEqual([`${c.resource}.archived`]);
      await expectContract(o, archive);

      const restore = await emitted(o, async () => {
        const res = await c.status(archived, 'restore', archived.version);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
      });
      expect(types(restore), c.resource).toEqual([`${c.resource}.updated`]);
      await expectContract(o, restore);
      // The restore event names the version the restore committed (one after the archive).
      expect(restore[0]!.payload.resource.version, c.resource).toBe(archived.version + 1);
    }
  }, 120_000);

  it('emits for the Public API write paths too, and never for draft invoices', async () => {
    const o = await bothSettings();
    const customer = await o.owner.post('/customers', {
      party: { kind: 'organization', displayName: 'Existing' },
    });
    const created = await o.owner.post('/api-integrations', {
      name: 'Events',
      scopes: ['customers:write', 'items:write', 'invoices:write'],
    });
    const token = (
      await o.owner.post(`/api-integrations/${created.body.data.id}/tokens`, { name: 'Prod' })
    ).body.data.token as string;
    const call = async (method: 'POST' | 'PATCH' | 'PUT', path: string, body: unknown) => {
      const res = await ctx.app.inject({
        method,
        url: `/public/v1${path}`,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        payload: JSON.stringify(body),
        remoteAddress: '203.0.113.7',
      });
      return { status: res.statusCode, body: res.json() };
    };
    const rows = await emitted(o, async () => {
      const c = await call('POST', '/customers', { kind: 'organization', name: 'Api Co' });
      expect(c.status, JSON.stringify(c.body)).toBe(201);
      expect(
        (await call('PATCH', `/customers/${c.body.data.id}`, { version: 1, phone: '1' })).status,
      ).toBe(200);
      const i = await call('POST', '/items', { name: 'Api item', item_type: 'service' });
      expect(i.status, JSON.stringify(i.body)).toBe(201);
      expect(
        (await call('PATCH', `/items/${i.body.data.id}`, { version: 1, description: 'x' })).status,
      ).toBe(200);
    });
    expect(types(rows)).toEqual([
      'customer.created',
      'customer.updated',
      'item.created',
      'item.updated',
    ]);
    await expectContract(o, rows);

    // Draft invoices (create and replace) are not events.
    const body = {
      customer_id: customer.body.data.id,
      invoice_date: '2026-03-12',
      lines: [{ description: 'Dive', quantity: '1', unit_price: '10' }],
    };
    const drafts = await emitted(o, async () => {
      const d = await call('POST', '/invoices', body);
      expect(d.status, JSON.stringify(d.body)).toBe(201);
      expect(
        (await call('PUT', `/invoices/${d.body.data.id}`, { version: 1, ...body })).status,
      ).toBe(200);
    });
    expect(drafts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

describe('sales document events', () => {
  it('emits issue, record and void events, once each, and nothing for drafts or credit applications', async () => {
    const o = await bothSettings();
    const customer = (
      await o.owner.post('/customers', { party: { kind: 'organization', displayName: 'Lagoon' } })
    ).body.data;

    let draft: any;
    expect(
      await emitted(o, async () => {
        draft = (
          await o.owner.post('/sales/invoices', {
            customerId: customer.id,
            invoiceDate: '2026-03-10',
            lines: [{ description: 'Services', quantity: '1', unitPrice: '100' }],
          })
        ).body.data;
        await o.owner.put(`/sales/invoices/${draft.id}`, {
          version: draft.version,
          customerId: customer.id,
          invoiceDate: '2026-03-10',
          lines: [{ description: 'Services', quantity: '1', unitPrice: '100' }],
        });
      }),
    ).toEqual([]);
    draft = (await o.owner.get(`/sales/invoices/${draft.id}`)).body.data;

    let invoice: any;
    const issue = await emitted(o, async () => {
      const res = await o.owner.post(`/sales/invoices/${draft.id}/issue`, {
        version: draft.version,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      invoice = res.body.data;
    });
    expect(types(issue)).toEqual(['invoice.issued']);
    await expectContract(o, issue);

    // A replay with the same Idempotency-Key does not issue (or emit) twice.
    const key = `k-${randomUUID()}`;
    const draft2 = (
      await o.owner.post('/sales/invoices', {
        customerId: customer.id,
        invoiceDate: '2026-03-11',
        lines: [{ description: 'More', quantity: '1', unitPrice: '10' }],
      })
    ).body.data;
    const replay = await emitted(o, async () => {
      for (let i = 0; i < 2; i += 1) {
        const res = await o.owner.post(
          `/sales/invoices/${draft2.id}/issue`,
          { version: draft2.version },
          { 'idempotency-key': key },
        );
        expect(res.status, JSON.stringify(res.body)).toBe(200);
      }
    });
    expect(types(replay)).toEqual(['invoice.issued']);

    // An issue that fails emits nothing: the invoice is no longer a draft.
    const failed = await emitted(o, async () => {
      const res = await o.owner.post(`/sales/invoices/${draft.id}/issue`, {
        version: invoice.version,
      });
      expect(res.status).toBe(409);
    });
    expect(failed).toEqual([]);

    const note = await emitted(o, async () => {
      const created = (
        await o.owner.post('/sales/credit-notes', {
          customerId: customer.id,
          creditDate: '2026-03-12',
          lines: [{ description: 'Returned', quantity: '1', unitPrice: '40' }],
        })
      ).body.data;
      const res = await o.owner.post(`/sales/credit-notes/${created.id}/issue`, {
        version: created.version,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    });
    expect(types(note)).toEqual(['credit_note.issued']);
    await expectContract(o, note);

    let receipt: any;
    const received = await emitted(o, async () => {
      const res = await o.owner.post('/sales/receipts', {
        customerId: customer.id,
        receiptDate: '2026-03-15',
        amount: '300',
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      receipt = res.body.data;
    });
    expect(types(received)).toEqual(['receipt.recorded']);
    await expectContract(o, received);

    let refund: any;
    const refunded = await emitted(o, async () => {
      const res = await o.owner.post('/sales/refunds', {
        sourceType: 'receipt',
        sourceId: receipt.id,
        refundDate: '2026-03-20',
        amount: '50',
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      refund = res.body.data;
    });
    expect(types(refunded)).toEqual(['customer_refund.recorded']);
    await expectContract(o, refunded);

    const refundVoid = await emitted(o, async () => {
      const res = await o.owner.post(`/sales/refunds/${refund.id}/void`, {
        version: refund.version,
        reason: 'x',
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    });
    expect(types(refundVoid)).toEqual(['customer_refund.voided']);
    await expectContract(o, refundVoid);

    const receiptVoid = await emitted(o, async () => {
      const current = (await o.owner.get(`/sales/receipts/${receipt.id}`)).body.data;
      const res = await o.owner.post(`/sales/receipts/${receipt.id}/void`, {
        version: current.version,
        reason: 'x',
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    });
    expect(types(receiptVoid)).toEqual(['receipt.voided']);
    await expectContract(o, receiptVoid);

    const invoiceVoid = await emitted(o, async () => {
      const current = (await o.owner.get(`/sales/invoices/${invoice.id}`)).body.data;
      const res = await o.owner.post(`/sales/invoices/${invoice.id}/void`, {
        version: current.version,
        reason: 'x',
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    });
    expect(types(invoiceVoid)).toEqual(['invoice.voided']);
    await expectContract(o, invoiceVoid);
  });
});

describe('purchase document events', () => {
  it('emits post, record and void events, and the several events of one operation', async () => {
    const o = await bothSettings();
    const vendor = (
      await o.owner.post('/vendors', { party: { kind: 'organization', displayName: 'Island' } })
    ).body.data;
    const bill = async (amount: string) => {
      const created = await o.owner.post('/purchases/bills', {
        vendorId: vendor.id,
        billDate: '2026-03-10',
        vendorReference: `INV-${randomUUID().slice(0, 8)}`,
        lines: [{ description: 'Stock', quantity: '1', unitPrice: amount, taxCodeId: null }],
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      return created.body.data;
    };

    // A draft is not an event; posting is.
    let draft: any;
    expect(await emitted(o, async () => (draft = await bill('100')))).toEqual([]);
    let posted: any;
    const post = await emitted(o, async () => {
      const res = await o.owner.post(`/purchases/bills/${draft.id}/post`, {
        version: draft.version,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      posted = res.body.data;
    });
    expect(types(post)).toEqual(['bill.posted']);
    await expectContract(o, post);

    let credit: any;
    const creditPost = await emitted(o, async () => {
      const created = (
        await o.owner.post('/purchases/vendor-credits', {
          origin: 'supplier_credit_note',
          vendorId: vendor.id,
          creditDate: '2026-03-12',
          vendorReference: `CN-${randomUUID().slice(0, 8)}`,
          lines: [{ description: 'Returned', quantity: '1', unitPrice: '40', taxCodeId: null }],
        })
      ).body.data;
      const res = await o.owner.post(`/purchases/vendor-credits/${created.id}/post`, {
        version: created.version,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      credit = res.body.data;
    });
    expect(types(creditPost)).toEqual(['vendor_credit.posted']);
    await expectContract(o, creditPost);

    let payment: any;
    const paid = await emitted(o, async () => {
      const created = await o.owner.post('/purchases/payments', {
        vendorId: vendor.id,
        paymentDate: '2026-03-10',
        allocations: [],
        amount: '500',
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const res = await o.owner.post(`/purchases/payments/${created.body.data.id}/record`, {
        version: created.body.data.version,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      payment = res.body.data;
    });
    expect(types(paid)).toEqual(['vendor_payment.recorded']);
    await expectContract(o, paid);

    let refund: any;
    const refunded = await emitted(o, async () => {
      const res = await o.owner.post('/purchases/refunds', {
        sourceType: 'payment',
        sourceId: payment.id,
        refundDate: '2026-03-20',
        amount: '50',
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      refund = res.body.data;
    });
    expect(types(refunded)).toEqual(['vendor_refund.recorded']);
    await expectContract(o, refunded);

    const body = (r: { version: number }) => ({ version: r.version, reason: 'x' });
    const refundVoid = await emitted(o, async () => {
      const res = await o.owner.post(`/purchases/refunds/${refund.id}/void`, body(refund));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    });
    expect(types(refundVoid)).toEqual(['vendor_refund.voided']);
    await expectContract(o, refundVoid);

    const paymentVoid = await emitted(o, async () => {
      const current = (await o.owner.get(`/purchases/payments/${payment.id}`)).body.data;
      const res = await o.owner.post(`/purchases/payments/${payment.id}/void`, body(current));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    });
    expect(types(paymentVoid)).toEqual(['vendor_payment.voided']);
    await expectContract(o, paymentVoid);

    const creditVoid = await emitted(o, async () => {
      const current = (await o.owner.get(`/purchases/vendor-credits/${credit.id}`)).body.data;
      const res = await o.owner.post(`/purchases/vendor-credits/${credit.id}/void`, body(current));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    });
    expect(types(creditVoid)).toEqual(['vendor_credit.voided']);
    await expectContract(o, creditVoid);

    const billVoid = await emitted(o, async () => {
      const current = (await o.owner.get(`/purchases/bills/${posted.id}`)).body.data;
      const res = await o.owner.post(`/purchases/bills/${posted.id}/void`, body(current));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    });
    expect(types(billVoid)).toEqual(['bill.voided']);
    await expectContract(o, billVoid);
  });

  it('emits both the claim and bill events (and the employee vendor) for an expense claim', async () => {
    const o = await bothSettings();
    const employee = await o.owner.post('/parties', {
      kind: 'individual',
      displayName: 'Aishath Ali',
      roles: ['employee'],
    });
    expect(employee.status, JSON.stringify(employee.body)).toBe(201);
    const claim = (
      await o.owner.post('/expense-claims', {
        employeePartyId: employee.body.data.id,
        claimDate: '2026-03-20',
        lines: [{ expenseDate: '2026-03-18', description: 'Taxi', amount: '60.00' }],
      })
    ).body.data;
    const submitted = (
      await o.owner.post(`/expense-claims/${claim.id}/submit`, { version: claim.version })
    ).body.data;
    expect(submitted.status).toBe('APPROVED');

    let posted: any;
    const post = await emitted(o, async () => {
      const res = await o.owner.post(`/expense-claims/${claim.id}/post`, {
        version: submitted.version,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      posted = res.body.data;
    });
    expect(types(post)).toEqual(['bill.posted', 'expense_claim.posted', 'vendor.created'].sort());
    await expectContract(o, post);

    // Posting again is idempotent: no second event.
    expect(
      await emitted(o, async () => {
        await o.owner.post(`/expense-claims/${claim.id}/post`, { version: posted.version });
      }),
    ).toEqual([]);

    const voided = await emitted(o, async () => {
      const current = (await o.owner.get(`/expense-claims/${claim.id}`)).body.data;
      const res = await o.owner.post(`/expense-claims/${claim.id}/void`, {
        version: current.version,
        reason: 'Duplicate',
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    });
    expect(types(voided)).toEqual(['bill.voided', 'expense_claim.voided']);
    await expectContract(o, voided);
  });
});

describe('approval-driven and repeated operations', () => {
  async function withPolicy(key: string) {
    const o = await bothSettings();
    const roles = (await o.owner.get('/organizations/current/roles')).body.data as {
      id: string;
      name: string;
    }[];
    const policy = await o.owner.put(`/approvals/policies/${key}`, {
      steps: [
        {
          name: 'Manager',
          requiredApprovals: 1,
          roleIds: [roles.find((r) => r.name === 'Administrator')!.id],
          membershipIds: [],
          conditions: { minBaseAmount: '100' },
        },
      ],
    });
    expect(policy.status, JSON.stringify(policy.body)).toBe(200);
    const admin = await joinWithRole(ctx, o.owner, 'Administrator');
    return { o, admin: admin.client };
  }

  it('emits invoice.issued exactly once, at Issue, not at submit or approval', async () => {
    const { o, admin } = await withPolicy('sales.invoice.issue');
    const customer = (
      await o.owner.post('/customers', { party: { kind: 'organization', displayName: 'Big' } })
    ).body.data;
    const created = (
      await o.owner.post('/sales/invoices', {
        customerId: customer.id,
        invoiceDate: '2026-03-10',
        lines: [{ description: 'Consulting', quantity: '4', unitPrice: '250' }],
      })
    ).body.data;
    expect(created.approval.required).toBe(true);
    const stages = await emitted(o, async () => {
      const refused = await o.owner.post(`/sales/invoices/${created.id}/issue`, {
        version: created.version,
      });
      expect(refused.body.error.code).toBe('APPROVAL_REQUIRED');
      const submitted = await o.owner.post(`/sales/invoices/${created.id}/submit`, {
        version: created.version,
      });
      expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
      const approved = await admin.post(
        `/approvals/requests/${submitted.body.data.approval.requestId}/approve`,
        {},
      );
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    });
    expect(stages).toEqual([]);

    const issue = await emitted(o, async () => {
      const current = (await o.owner.get(`/sales/invoices/${created.id}`)).body.data;
      const key = `k-${randomUUID()}`;
      for (let i = 0; i < 2; i += 1) {
        const res = await o.owner.post(
          `/sales/invoices/${created.id}/issue`,
          { version: current.version },
          { 'idempotency-key': key },
        );
        expect(res.status, JSON.stringify(res.body)).toBe(200);
      }
      // Issuing the issued invoice again (new key) is refused and emits nothing more.
      const again = await o.owner.post(`/sales/invoices/${created.id}/issue`, {
        version: current.version,
      });
      expect(again.status).toBe(409);
    });
    expect(types(issue)).toEqual(['invoice.issued']);
    await expectContract(o, issue);
  });

  it('emits bill.posted exactly once, at Post, not at submit or approval', async () => {
    const { o, admin } = await withPolicy('purchases.bill.post');
    const vendor = (
      await o.owner.post('/vendors', { party: { kind: 'organization', displayName: 'Big V' } })
    ).body.data;
    const created = (
      await o.owner.post('/purchases/bills', {
        vendorId: vendor.id,
        billDate: '2026-03-10',
        vendorReference: `INV-${randomUUID().slice(0, 8)}`,
        lines: [{ description: 'Generator', quantity: '1', unitPrice: '800', taxCodeId: null }],
      })
    ).body.data;
    expect(created.approval.required).toBe(true);
    const stages = await emitted(o, async () => {
      const refused = await o.owner.post(`/purchases/bills/${created.id}/post`, {
        version: created.version,
      });
      expect(refused.body.error.code).toBe('APPROVAL_REQUIRED');
      const submitted = await o.owner.post(`/purchases/bills/${created.id}/submit`, {
        version: created.version,
      });
      expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
      const approved = await admin.post(
        `/approvals/requests/${submitted.body.data.approval.requestId}/approve`,
        {},
      );
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    });
    expect(stages).toEqual([]);

    const post = await emitted(o, async () => {
      const current = (await o.owner.get(`/purchases/bills/${created.id}`)).body.data;
      const res = await o.owner.post(`/purchases/bills/${created.id}/post`, {
        version: current.version,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const again = await o.owner.post(`/purchases/bills/${created.id}/post`, {
        version: current.version,
      });
      expect(again.status).toBe(409);
    });
    expect(types(post)).toEqual(['bill.posted']);
    await expectContract(o, post);
  });

  it('creates one event for a retried receipt and a retried Public API create', async () => {
    const o = await bothSettings();
    const customer = (
      await o.owner.post('/customers', { party: { kind: 'organization', displayName: 'Retry' } })
    ).body.data;
    const receipt = await emitted(o, async () => {
      const key = `r-${randomUUID()}`;
      for (let i = 0; i < 3; i += 1) {
        const res = await o.owner.post(
          '/sales/receipts',
          { customerId: customer.id, receiptDate: '2026-03-15', amount: '25' },
          { 'idempotency-key': key },
        );
        expect(res.status, JSON.stringify(res.body)).toBe(201);
      }
    });
    expect(types(receipt)).toEqual(['receipt.recorded']);

    const integration = await o.owner.post('/api-integrations', {
      name: 'Retry',
      scopes: ['customers:write'],
    });
    const token = (
      await o.owner.post(`/api-integrations/${integration.body.data.id}/tokens`, { name: 'Prod' })
    ).body.data.token as string;
    const created = await emitted(o, async () => {
      const key = `c-${randomUUID()}`;
      for (let i = 0; i < 3; i += 1) {
        const res = await ctx.app.inject({
          method: 'POST',
          url: '/public/v1/customers',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            'idempotency-key': key,
          },
          payload: JSON.stringify({ kind: 'organization', name: 'Retried Co' }),
          remoteAddress: '203.0.113.9',
        });
        expect(res.statusCode, res.body).toBe(201);
      }
    });
    expect(types(created)).toEqual(['customer.created']);
    await expectContract(o, created);
  });
});

describe('Contacts-only identity updates', () => {
  const partyOf = async (table: string, id: string) =>
    (
      await sql(
        `SELECT t.party_id, t.version AS record_version, p.version AS party_version
           FROM ${table} t JOIN parties p ON p.id = t.party_id WHERE t.id = $1`,
        [id],
      )
    ).rows[0] as { party_id: string; record_version: number; party_version: number };

  const edit = (o: AccountingOrg, partyId: string, version: number, phone: string) =>
    o.owner.patch(`/parties/${partyId}`, { version, phone });

  it('emits customer.updated and vendor.updated, with the unchanged record version', async () => {
    const o = await bothSettings();
    for (const [resource, route, table] of [
      ['customer', '/customers', 'customers'],
      ['vendor', '/vendors', 'vendors'],
    ] as const) {
      const record = (
        await o.owner.post(route, { party: { kind: 'organization', displayName: `C ${resource}` } })
      ).body.data;
      let state = await partyOf(table, record.id);

      const first = await emitted(o, async () => {
        const res = await edit(o, state.party_id, state.party_version, '+960 111');
        expect(res.status, JSON.stringify(res.body)).toBe(200);
      });
      expect(types(first), resource).toEqual([`${resource}.updated`]);
      expect(first[0]!.payload.resource.id).toBe(record.id);
      // A notification, not a change log: the record's own version is neither advanced nor invented.
      expect(first[0]!.payload.resource.version).toBe(state.record_version);
      expect((await partyOf(table, record.id)).record_version).toBe(state.record_version);
      await expectContract(o, first);

      // Each effective edit is exactly one event; an edit that changes nothing is none.
      state = await partyOf(table, record.id);
      const again = await emitted(o, async () => {
        expect((await edit(o, state.party_id, state.party_version, '+960 222')).status).toBe(200);
      });
      expect(types(again), resource).toEqual([`${resource}.updated`]);
      state = await partyOf(table, record.id);
      const noop = await emitted(o, async () => {
        expect((await edit(o, state.party_id, state.party_version, '+960 222')).status).toBe(200);
      });
      expect(noop, `${resource} no-op`).toEqual([]);

      // A stale edit fails and emits nothing.
      const stale = await emitted(o, async () => {
        expect((await edit(o, state.party_id, state.party_version - 1, '+960 333')).status).toBe(
          409,
        );
      });
      expect(stale, `${resource} stale`).toEqual([]);
    }
  });

  it('emits nothing for a contact that is neither a customer nor a vendor, or for contact details', async () => {
    const o = await bothSettings();
    const plain = (
      await o.owner.post('/parties', {
        kind: 'individual',
        displayName: 'Just a contact',
        roles: [],
      })
    ).body.data;
    const rows = await emitted(o, async () => {
      const res = await edit(o, plain.id, plain.version, '+960 444');
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    });
    expect(rows).toEqual([]);
  });

  it('emits one event per role record, and none twice from the customer or vendor screens', async () => {
    const o = await bothSettings();
    const customer = (
      await o.owner.post('/customers', {
        party: { kind: 'organization', displayName: 'Both roles', roles: ['vendor'] },
      })
    ).body.data;
    const partyId = (await partyOf('customers', customer.id)).party_id;
    const vendor = (await o.owner.post('/vendors', { partyId })).body.data;
    expect(vendor.id).toBeDefined();

    // The Contacts screen reports to both records.
    let state = await partyOf('customers', customer.id);
    const contacts = await emitted(o, async () => {
      expect((await edit(o, partyId, state.party_version, '+960 555')).status).toBe(200);
    });
    expect(types(contacts)).toEqual(['customer.updated', 'vendor.updated']);
    await expectContract(o, contacts);

    // The customer screen reports its own record once (not again through the Contacts hook) and
    // the vendor, whose view of the same party changed, once.
    state = await partyOf('customers', customer.id);
    const fromCustomer = await emitted(o, async () => {
      const res = await o.owner.patch(`/customers/${customer.id}`, {
        version: state.record_version,
        party: { version: state.party_version, phone: '+960 666' },
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    });
    expect(types(fromCustomer)).toEqual(['customer.updated', 'vendor.updated']);
    await expectContract(o, fromCustomer);
  });

  it('rolls the event back with a failed transaction and keeps tenants apart', async () => {
    const a = await bothSettings();
    const b = await bothSettings();
    const mine = (
      await a.owner.post('/customers', { party: { kind: 'organization', displayName: 'Mine' } })
    ).body.data;
    const theirs = (
      await b.owner.post('/customers', { party: { kind: 'organization', displayName: 'Theirs' } })
    ).body.data;
    const mineState = await partyOf('customers', mine.id);
    const theirState = await partyOf('customers', theirs.id);

    // The party edit and its event are one transaction: if it throws afterwards, neither remains.
    const ownerRow = (
      await sql(`SELECT user_id FROM memberships WHERE id = $1`, [a.ownerMembershipId])
    ).rows[0];
    const rolledBack = await emitted(a, async () => {
      await expect(
        inTransaction(ctx.database.db, { organizationId: a.organizationId }, async (tx) => {
          await ctx.services.parties.updateInTransaction(
            tx,
            {
              userId: ownerRow.user_id,
              sessionId: null,
              organizationId: a.organizationId,
              membershipId: a.ownerMembershipId,
              isOwner: true,
              roleIds: [],
              permissions: new Set(['parties.update']),
            },
            mineState.party_id,
            { version: mineState.party_version, phone: '+960 777' },
            { ipAddress: null, userAgent: null } as never,
          );
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
    });
    expect(rolledBack).toEqual([]);
    expect((await partyOf('customers', mine.id)).party_version).toBe(mineState.party_version);

    // A Contacts edit in organization B produces an event only there.
    const aBefore = (await outbox(a.organizationId)).length;
    const inB = await emitted(b, async () => {
      expect(
        (await edit(b, theirState.party_id, theirState.party_version, '+960 888')).status,
      ).toBe(200);
    });
    expect(types(inB)).toEqual(['customer.updated']);
    expect(inB[0]!.payload.organization_id).toBe(b.organizationId);
    expect(inB[0]!.payload.resource.id).toBe(theirs.id);
    expect((await outbox(a.organizationId)).length).toBe(aBefore);
  });
});

describe('opening documents', () => {
  it('emit no events when posted or voided (opening invoice, bill and vendor credit)', async () => {
    const o = await bothSettings();
    const set = await o.owner.put('/accounting/settings/conversion-date', {
      conversionDate: '2026-01-02',
    });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const customer = (
      await o.owner.post('/customers', { party: { kind: 'organization', displayName: 'Opening' } })
    ).body.data;
    const vendor = (
      await o.owner.post('/vendors', { party: { kind: 'organization', displayName: 'Opening V' } })
    ).body.data;
    const line = [{ description: 'Balance at conversion', quantity: '1', unitPrice: '1200' }];
    const rows = await emitted(o, async () => {
      const documents: [string, string, object][] = [
        [
          '/sales/invoices',
          'issue',
          { kind: 'opening', customerId: customer.id, invoiceDate: '2026-01-01', lines: line },
        ],
        [
          '/purchases/bills',
          'post',
          { kind: 'opening', vendorId: vendor.id, billDate: '2026-01-01', lines: line },
        ],
        [
          '/purchases/vendor-credits',
          'post',
          {
            kind: 'opening',
            origin: 'supplier_credit_note',
            vendorId: vendor.id,
            creditDate: '2026-01-01',
            lines: line,
          },
        ],
      ];
      for (const [path, action, body] of documents) {
        const created = await o.owner.post(path, body);
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        const done = await o.owner.post(`${path}/${created.body.data.id}/${action}`, {
          version: created.body.data.version,
        });
        expect(done.status, JSON.stringify(done.body)).toBe(200);
        const voided = await o.owner.post(`${path}/${created.body.data.id}/void`, {
          version: done.body.data.version,
          reason: 'x',
        });
        expect(voided.status, JSON.stringify(voided.body)).toBe(200);
      }
    });
    expect(rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Transaction boundaries, isolation, accounting
// ---------------------------------------------------------------------------

describe('public event guarantees', () => {
  it('writes no event when the operation rolls back, and delivers nothing', async () => {
    const o = await bothSettings();
    const customer = (
      await o.owner.post('/customers', { party: { kind: 'organization', displayName: 'Rollback' } })
    ).body.data;
    // Issue fails inside the transaction (no revenue account resolvable once removed would be
    // fragile); a closed period fails after the number is taken, so everything rolls back.
    const draft = (
      await o.owner.post('/sales/invoices', {
        customerId: customer.id,
        invoiceDate: '2025-06-01',
        lines: [{ description: 'Old', quantity: '1', unitPrice: '10' }],
      })
    ).body;
    const rows = await emitted(o, async () => {
      if (draft.data) {
        const res = await o.owner.post(`/sales/invoices/${draft.data.id}/issue`, {
          version: draft.data.version,
        });
        expect(res.status).toBeGreaterThanOrEqual(400);
      }
      const dup = await o.owner.post('/sales/items', {
        name: 'Dup',
        sku: 'S-1',
        itemType: 'service',
      });
      expect(dup.status).toBe(201);
      const again = await o.owner.post('/sales/items', {
        name: 'Dup 2',
        sku: 'S-1',
        itemType: 'service',
      });
      expect(again.status).toBe(409);
    });
    // Only the item that committed produced an event.
    expect(types(rows)).toEqual(['item.created']);

    // Emission is only an insert: nothing marks the rows delivered, processed or attempted.
    const all = await outbox(o.organizationId);
    expect(all.every((r) => r.status === 'pending')).toBe(true);
    const attempts = await sql(
      `SELECT count(*)::int AS n FROM outbox_events WHERE organization_id = $1 AND event_type LIKE 'public.%' AND attempts > 0`,
      [o.organizationId],
    );
    expect(attempts.rows[0].n).toBe(0);
  });

  it('is invisible to dispatchers and handlers of other event types', async () => {
    const o = await bothSettings();
    await o.owner.post('/customers', { party: { kind: 'organization', displayName: 'Isolated' } });
    const before = await outbox(o.organizationId);
    expect(before).toHaveLength(1);
    // A dispatcher restricted to other types never claims the row, and a handler subscribed to
    // another type is never called with it (handlers are matched by exact event type).
    const seen: string[] = [];
    const other = new OutboxDispatcher(ctx.database.db, {
      batchSize: 50,
      eventTypes: ['unrelated.type'],
    });
    other.subscribe('unrelated.type', async (event) => void seen.push(event.eventType));
    other.subscribe('customer.created', async (event) => void seen.push(event.eventType));
    const result = await other.dispatchBatch();
    expect(result.claimed).toBe(0);
    expect(seen).toEqual([]);
    const after = await outbox(o.organizationId);
    expect(after.map((r) => r.status)).toEqual(['pending']);
    // The internal type is namespaced: the unprefixed domain type is never used for a public row.
    expect(after.every((r) => r.event_type.startsWith('public.'))).toBe(true);
  });

  it('rolls the event back with the transaction that carries it', async () => {
    const o = await bothSettings();
    const probe = randomUUID();
    await expect(
      inTransaction(ctx.database.db, { organizationId: o.organizationId }, async (tx) => {
        await publishPublicEvent(
          tx,
          {
            type: 'customer.created',
            organizationId: o.organizationId,
            resourceId: probe,
            version: 1,
          },
          new Date(),
        );
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect((await outbox(o.organizationId)).filter((r) => r.aggregate_id === probe)).toEqual([]);
  });

  it('keeps events inside their organization', async () => {
    const a = await bothSettings();
    const b = await bothSettings();
    await a.owner.post('/customers', { party: { kind: 'organization', displayName: 'A only' } });
    await b.owner.post('/customers', { party: { kind: 'organization', displayName: 'B only' } });
    const ra = await outbox(a.organizationId);
    const rb = await outbox(b.organizationId);
    expect(ra).toHaveLength(1);
    expect(rb).toHaveLength(1);
    expect(ra[0]!.payload.organization_id).toBe(a.organizationId);
    expect(rb[0]!.payload.organization_id).toBe(b.organizationId);
    expect(ra[0]!.payload.resource.id).not.toBe(rb[0]!.payload.resource.id);
    // Event ids are unique across all events.
    const ids = new Set([...ra, ...rb].map((r) => r.payload.id));
    expect(ids.size).toBe(2);
  });

  it('adds no accounting effect: no journal, line or accounting event is created by emission', async () => {
    const o = await bothSettings();
    const footprint = async () =>
      (
        await sql(
          `SELECT (SELECT count(*) FROM accounting_journal_entries WHERE organization_id = $1)::int AS journals,
                  (SELECT count(*) FROM accounting_journal_lines WHERE organization_id = $1)::int AS lines,
                  (SELECT count(*) FROM accounting_events WHERE organization_id = $1)::int AS events`,
          [o.organizationId],
        )
      ).rows[0];
    const before = await footprint();
    const rows = await emitted(o, async () => {
      const c = await o.owner.post('/customers', {
        party: { kind: 'organization', displayName: 'No ledger' },
      });
      await o.owner.patch(`/customers/${c.body.data.id}`, {
        version: c.body.data.version,
        paymentTermsDays: 5,
      });
      await o.owner.post('/sales/items', { name: 'No ledger', itemType: 'service' });
    });
    expect(rows).toHaveLength(3);
    expect(await footprint()).toEqual(before);
    // Payloads carry identity only: no amounts, journal ids or changed fields.
    const text = JSON.stringify(rows.map((r) => r.payload));
    expect(text).not.toMatch(/journal|amount|total|before|after|changed|account|balance/i);
    // No event of an excluded family exists for the organization.
    const all = await sql(
      `SELECT DISTINCT event_type FROM outbox_events WHERE organization_id = $1 AND event_type LIKE 'public.%'`,
      [o.organizationId],
    );
    for (const r of all.rows) {
      expect(PUBLIC_EVENT_TYPES).toContain((r.event_type as string).replace(/^public\./, ''));
    }
  });
});
