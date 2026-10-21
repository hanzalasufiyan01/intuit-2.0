import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { joinWithRole, setUpAccountingOrg, type AccountingOrg } from './fixtures.js';
import { connectAs, createTestContext, type TestContext } from './helpers.js';

/**
 * Branch-scoped access (FP-24, migration 0084). A member limited to branches (dimension values)
 * sees only invoices and bills tagged with them: row-level security, not the services, enforces
 * it. Real PostgreSQL.
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

interface Org extends AccountingOrg {
  customerId: string;
  north: string;
  south: string;
  clerk: Awaited<ReturnType<typeof joinWithRole>>;
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
  const customer = await o.owner.post('/customers', {
    party: { kind: 'organization', displayName: 'Branch customer' },
  });
  expect(customer.status, JSON.stringify(customer.body)).toBe(201);
  const type = await o.owner.post('/accounting/dimensions', { code: 'BRANCH', name: 'Branch' });
  expect(type.status, JSON.stringify(type.body)).toBe(201);
  const value = async (code: string) => {
    const r = await o.owner.post(`/accounting/dimensions/${type.body.data.id}/values`, {
      code,
      name: code,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.data.id as string;
  };
  const north = await value('NORTH');
  const south = await value('SOUTH');
  const role = await o.owner.post('/organizations/current/roles', {
    name: 'Branch clerk',
    permissionKeys: [
      'organization.read',
      'accounting.dimensions.view',
      'customers.view',
      'invoices.view',
      'invoices.create',
      'invoices.issue',
      'invoices.edit_draft',
      'vendors.view',
      'bills.view',
      'bills.create',
      'bills.edit_draft',
      'bills.post',
      'accounting.reports.view',
    ],
  });
  expect(role.status, JSON.stringify(role.body)).toBe(201);
  const clerk = await joinWithRole(ctx, o.owner, 'Branch clerk');
  return { ...o, customerId: customer.body.data.id, north, south, clerk };
}

const invoice = (o: Org, branch: string) => ({
  customerId: o.customerId,
  invoiceDate: '2026-03-10',
  dimensionValueIds: [branch],
  lines: [{ description: 'Work', quantity: '1', unitPrice: '100' }],
});

async function restrict(o: Org, ids: string[]) {
  const r = await o.owner.put(
    `/organizations/current/members/${o.clerk.membershipId}/branch-scope`,
    { dimensionValueIds: ids },
  );
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.data;
}

describe('branch-scoped access', () => {
  it('shows a restricted member only their branch, narrows permissions, and can be lifted', async () => {
    const o = await org();
    const n = await o.owner.post('/sales/invoices', invoice(o, o.north));
    const s = await o.owner.post('/sales/invoices', invoice(o, o.south));
    expect(n.status).toBe(201);
    expect(s.status).toBe(201);

    // Unrestricted: sees both and may run reports.
    const before = await o.clerk.client.get('/sales/invoices');
    expect(before.body.data.items.length).toBe(2);
    expect((await o.clerk.client.get('/accounting/reports/trial-balance')).status).toBe(200);

    const set = await restrict(o, [o.north]);
    expect(set.restricted).toBe(true);
    expect(set.branches.map((b: { code: string }) => b.code)).toEqual(['NORTH']);

    const list = await o.clerk.client.get('/sales/invoices');
    expect(list.status).toBe(200);
    expect(list.body.data.items.map((i: { id: string }) => i.id)).toEqual([n.body.data.id]);
    expect((await o.clerk.client.get(`/sales/invoices/${n.body.data.id}`)).status).toBe(200);
    expect((await o.clerk.client.get(`/sales/invoices/${s.body.data.id}`)).status).toBe(404);

    // A permission outside the allow-list is removed, even though the role has it.
    expect((await o.clerk.client.get('/accounting/reports/trial-balance')).status).toBe(403);

    // Own branch works; the other branch is refused by the database.
    const own = await o.clerk.client.post('/sales/invoices', invoice(o, o.north));
    expect(own.status, JSON.stringify(own.body)).toBe(201);
    const issued = await o.clerk.client.post(`/sales/invoices/${own.body.data.id}/issue`, {
      version: own.body.data.version,
    });
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    const other = await o.clerk.client.post('/sales/invoices', invoice(o, o.south));
    expect(other.status).toBe(400);
    expect(other.body.error.details.issues[0].path).toBe('dimensionValueIds');
    expect(JSON.stringify(other.body)).not.toContain(o.south);
    const untagged = await o.clerk.client.post('/sales/invoices', {
      ...invoice(o, o.north),
      dimensionValueIds: [],
    });
    expect(untagged.status).toBe(400);

    // The owner is unaffected and the list is visible to administrators.
    expect((await o.owner.get('/sales/invoices')).body.data.items.length).toBe(3);
    const all = await o.owner.get('/organizations/current/branch-scopes');
    expect(all.body.data).toHaveLength(1);

    // Lifting the restriction restores everything.
    const lifted = await restrict(o, []);
    expect(lifted.restricted).toBe(false);
    expect((await o.clerk.client.get('/sales/invoices')).body.data.items.length).toBe(3);
    expect((await o.clerk.client.get('/accounting/reports/trial-balance')).status).toBe(200);
  });

  it('refuses invalid scopes and protects the owner and the actor', async () => {
    const o = await org();
    const path = (id: string) => `/organizations/current/members/${id}/branch-scope`;
    const ownerMember = (await o.owner.get('/organizations/current/members')).body.data.find(
      (m: { isOwner?: boolean }) => m.isOwner,
    );
    if (ownerMember) {
      const refused = await o.owner.put(path(ownerMember.membershipId), {
        dimensionValueIds: [o.north],
      });
      expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    }
    expect(
      (await o.owner.put(path(o.clerk.membershipId), { dimensionValueIds: ['not-a-uuid'] })).status,
    ).toBe(400);
    expect(
      (
        await o.owner.put(path(o.clerk.membershipId), {
          dimensionValueIds: ['11111111-1111-4111-8111-111111111111'],
        })
      ).status,
    ).toBe(400);
    // A restricted member cannot change scopes (including their own).
    await restrict(o, [o.north]);
    expect(
      (await o.clerk.client.put(path(o.clerk.membershipId), { dimensionValueIds: [] })).status,
    ).toBe(403);
    const audit = await db.query(
      `SELECT count(*)::int AS n FROM audit_events WHERE organization_id = $1 AND action = 'member.branch_scope_set'`,
      [o.organizationId],
    );
    expect(audit.rows[0].n).toBe(1);
  });

  it('keeps scopes inside their tenant', async () => {
    const a = await org();
    const b = await org();
    await restrict(a, [a.north]);
    expect((await b.owner.get('/organizations/current/branch-scopes')).body.data).toEqual([]);
    expect(
      (
        await b.owner.put(`/organizations/current/members/${a.clerk.membershipId}/branch-scope`, {
          dimensionValueIds: [],
        })
      ).status,
    ).toBe(404);
    // A scope cannot reference another tenant's dimension value.
    expect(
      (
        await b.owner.put(`/organizations/current/members/${b.clerk.membershipId}/branch-scope`, {
          dimensionValueIds: [a.north],
        })
      ).status,
    ).toBe(400);
  });
});

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 1),
]);

interface Scoped extends Org {
  vendorId: string;
  inNorth: { invoice: { id: string; number: string }; bill: { id: string; number: string } };
  inSouth: { invoice: { id: string; number: string }; bill: { id: string; number: string } };
}

/** Sales and purchases set up, one issued invoice and one posted bill per branch, clerk limited to NORTH. */
async function scopedOrg(): Promise<Scoped> {
  const o = await org();
  expect(
    (
      await o.owner.put('/purchases/settings', {
        version: 0,
        apAccountId: o.accounts['2110'],
        defaultExpenseAccountId: o.accounts['5400'],
        defaultPaymentAccountId: o.accounts['1120'],
        defaultTaxCodeId: null,
        defaultTaxTreatment: 'exclusive',
        defaultPaymentTermsDays: 30,
      })
    ).status,
  ).toBe(200);
  const vendor = await o.owner.post('/vendors', {
    party: { kind: 'organization', displayName: 'Branch vendor' },
  });
  expect(vendor.status, JSON.stringify(vendor.body)).toBe(201);
  const make = async (branch: string, ref: string) => {
    const inv = await o.owner.post('/sales/invoices', invoice(o, branch));
    const issued = await o.owner.post(`/sales/invoices/${inv.body.data.id}/issue`, {
      version: inv.body.data.version,
    });
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    const bill = await o.owner.post('/purchases/bills', {
      vendorId: vendor.body.data.id,
      billDate: '2026-03-10',
      vendorReference: ref,
      dimensionValueIds: [branch],
      lines: [{ description: 'Supplies', quantity: '1', unitPrice: '50', taxCodeId: null }],
    });
    expect(bill.status, JSON.stringify(bill.body)).toBe(201);
    const posted = await o.owner.post(`/purchases/bills/${bill.body.data.id}/post`, {
      version: bill.body.data.version,
    });
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    return {
      invoice: { id: inv.body.data.id as string, number: issued.body.data.number as string },
      bill: { id: bill.body.data.id as string, number: posted.body.data.number as string },
    };
  };
  const inNorth = await make(o.north, 'NORTH-REF-1');
  const inSouth = await make(o.south, 'SOUTH-REF-1');
  await restrict(o, [o.north]);
  return { ...o, vendorId: vendor.body.data.id, inNorth, inSouth };
}

describe('branch scope: bills, friendly errors and leak checks', () => {
  it('gives a readable error for a bill outside the member branches and reveals nothing', async () => {
    const o = await scopedOrg();
    const draft = (branches: string[], ref: string) => ({
      vendorId: o.vendorId,
      billDate: '2026-03-12',
      vendorReference: ref,
      dimensionValueIds: branches,
      lines: [{ description: 'More', quantity: '1', unitPrice: '10', taxCodeId: null }],
    });
    const other = await o.clerk.client.post('/purchases/bills', draft([o.south], 'X-1'));
    expect(other.status).toBe(400);
    expect(other.body.error.details.issues[0].path).toBe('dimensionValueIds');
    expect(JSON.stringify(other.body)).not.toContain(o.south);
    expect((await o.clerk.client.post('/purchases/bills', draft([], 'X-2'))).status).toBe(400);
    const own = await o.clerk.client.post('/purchases/bills', draft([o.north], 'X-3'));
    expect(own.status, JSON.stringify(own.body)).toBe(201);
    // Editing a draft to another branch is refused the same way.
    const moved = await o.clerk.client.put(`/purchases/bills/${own.body.data.id}`, {
      ...draft([o.south], 'X-3'),
      version: own.body.data.version,
    });
    expect(moved.status).toBe(400);
    expect(moved.body.error.details.issues[0].path).toBe('dimensionValueIds');
    // The other branch's bill is invisible and untouchable.
    const list = await o.clerk.client.get('/purchases/bills');
    expect(JSON.stringify(list.body)).not.toContain(o.inSouth.bill.number);
    expect((await o.clerk.client.get(`/purchases/bills/${o.inSouth.bill.id}`)).status).toBe(404);
  });

  it('keeps the other branch out of search, related resources, files and exports', async () => {
    const o = await scopedOrg();
    const c = o.clerk.client;
    const southNumbers = [o.inSouth.invoice.number, o.inSouth.bill.number];
    // Search by the other branch's document number finds nothing; by the own number finds it.
    for (const [path, own, other] of [
      ['/sales/search', o.inNorth.invoice.number, o.inSouth.invoice.number],
      ['/purchases/search', o.inNorth.bill.number, o.inSouth.bill.number],
    ] as const) {
      const hit = await c.get(`${path}?q=${encodeURIComponent(own)}`);
      expect(hit.status, path).toBe(200);
      expect(JSON.stringify(hit.body), path).toContain(own);
      const miss = await c.get(`${path}?q=${encodeURIComponent(other)}`);
      expect(miss.status, path).toBe(200);
      expect(
        JSON.stringify(miss.body.data.invoices ?? miss.body.data.bills ?? []),
        path,
      ).not.toContain(other);
    }
    // Related resources of the other branch's documents are 404 (or refused), never data.
    for (const path of [
      `/sales/invoices/${o.inSouth.invoice.id}/pdf`,
      `/sales/invoices/${o.inSouth.invoice.id}/emails`,
      `/purchases/bills/${o.inSouth.bill.id}/allocations`,
      `/files?linkType=invoice&linkId=${o.inSouth.invoice.id}`,
    ]) {
      const r = await c.get(path);
      expect([403, 404], path).toContain(r.status);
    }
    // A file attached to the other branch's invoice cannot be read by id either.
    const file = await o.owner.upload(
      `/files?linkType=invoice&linkId=${o.inSouth.invoice.id}`,
      PNG,
      'po.png',
    );
    expect(file.status, JSON.stringify(file.body)).toBe(201);
    const fileId = file.body.data.id as string;
    expect([403, 404]).toContain((await c.get(`/files/${fileId}`)).status);
    expect([403, 404]).toContain((await c.get(`/files/${fileId}/download-url`)).status);
    expect([403, 404]).toContain((await c.delete(`/files/${fileId}`)).status);
    // Exports run as the member and are branch-limited too.
    for (const domain of ['invoices', 'bills'] as const) {
      const created = await c.post('/exports', { domain, params: {} });
      expect(created.status, JSON.stringify(created.body)).toBe(202);
      const id = created.body.data.export.id as string;
      let view = (await c.get(`/exports/${id}`)).body.data;
      // Only this organization's jobs: the queue is shared with every test file running in
      // parallel, and their document PDFs would otherwise be processed first (CI, 2026-10-20).
      for (let i = 0; i < 200 && ['queued', 'running'].includes(view.status); i++) {
        await ctx.worker.runOnce({ organizationId: o.organizationId });
        view = (await c.get(`/exports/${id}`)).body.data;
      }
      expect(view.status, JSON.stringify(view)).toBe('ready');
      const link = await c.get(`/exports/${id}/download-url`);
      const res = await ctx.app.inject({ method: 'GET', url: link.body.data.url });
      expect(res.statusCode).toBe(200);
      const own = domain === 'invoices' ? o.inNorth.invoice.number : o.inNorth.bill.number;
      expect(res.body, domain).toContain(own);
      for (const n of southNumbers) expect(res.body, domain).not.toContain(n);
    }
    // Permissions outside the allow-list stay removed even though the role has them.
    expect((await c.get('/accounting/reports/trial-balance')).status).toBe(403);
    expect((await c.get('/accounting/reports/profit-and-loss')).status).toBe(403);
  });

  it('never lets another tenant reach a scoped organization', async () => {
    const a = await scopedOrg();
    const b = await scopedOrg();
    for (const path of [
      `/sales/invoices/${a.inNorth.invoice.id}`,
      `/purchases/bills/${a.inNorth.bill.id}`,
    ]) {
      expect((await b.clerk.client.get(path)).status, path).toBe(404);
      expect((await b.owner.get(path)).status, path).toBe(404);
    }
  });
});

describe('sales by branch (master specification section 16, document level)', () => {
  it('splits issued sales by the branch of each line, with unassigned and credit notes, and needs the dimension permission', async () => {
    const o = await scopedOrg();
    const typeId = (
      (await o.owner.get('/accounting/dimensions')).body.data as { id: string; code: string }[]
    ).find((t) => t.code === 'BRANCH')!.id;
    const issue = async (body: object) => {
      const inv = await o.owner.post('/sales/invoices', {
        customerId: o.customerId,
        invoiceDate: '2026-03-12',
        ...body,
      });
      expect(inv.status, JSON.stringify(inv.body)).toBe(201);
      const issued = await o.owner.post(`/sales/invoices/${inv.body.data.id}/issue`, {
        version: inv.body.data.version,
      });
      expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    };
    // The helper in scopedOrg already issued one 100.00 invoice for each branch on 2026-03-10.
    await issue({ lines: [{ description: 'Untagged', quantity: '1', unitPrice: '40' }] });
    // Document is NORTH, but this line is explicitly SOUTH: the line wins.
    await issue({
      dimensionValueIds: [o.north],
      lines: [
        { description: 'Mixed N', quantity: '1', unitPrice: '10' },
        { description: 'Mixed S', quantity: '1', unitPrice: '25', dimensionValueIds: [o.south] },
      ],
    });
    const url = `/sales/reports/sales-by-dimension?dimensionTypeId=${typeId}&from=2026-03-01&to=2026-03-31`;
    const report = await o.owner.get(url);
    expect(report.status, JSON.stringify(report.body)).toBe(200);
    const by = Object.fromEntries(
      report.body.data.values.map((v: { code: string | null; netSales: string }) => [
        v.code ?? 'unassigned',
        Number(v.netSales),
      ]),
    );
    expect(by).toEqual({ NORTH: 110, SOUTH: 125, unassigned: 40 });
    expect(Number(report.body.data.totals.netSales)).toBe(275);
    // The ordinary customer report agrees with the total.
    const byCustomer = await o.owner.get(
      '/sales/reports/sales-by-customer?from=2026-03-01&to=2026-03-31',
    );
    expect(Number(byCustomer.body.data.totals.netSales)).toBe(275);
    // Needs sales.reports.view AND accounting.dimensions.view; unknown types are refused.
    expect(
      (
        await o.owner.get(
          '/sales/reports/sales-by-dimension?dimensionTypeId=11111111-1111-4111-8111-111111111111&from=2026-03-01&to=2026-03-31',
        )
      ).status,
    ).toBe(400);
    // The restricted clerk lost reports altogether (branch scope removes the permission).
    expect((await o.clerk.client.get(url)).status).toBe(403);
    const other = await scopedOrg();
    expect((await other.owner.get(url)).status).toBe(400);
  });
});
