import { randomInt, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildOpenApiDocument } from '../src/api/public/openapi.js';
import { InMemoryRateLimiter } from '../src/application/rate-limiter.js';
import { joinWithRole, setUpAccountingOrg, type AccountingOrg } from './fixtures.js';
import { connectAs, createTestContext, DAY, type TestClient, type TestContext } from './helpers.js';

/**
 * ADR 0011 Step 3: the Public API foundation (`/public/v1`) and its reads (the Step 4 draft writes
 * are in public-api-writes.test.ts). Authentication through
 * IntegrationAuthService only, the fixed platform policy within the current non-Owner permission
 * boundary, cursor pagination, DTO isolation, the error contract, PostgreSQL rate limiting and the
 * OpenAPI document.
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
const uniqueIp = () => `198.51.${randomInt(0, 256)}.${randomInt(1, 255)}`;
const ALL_READ = ['customers:read', 'vendors:read', 'invoices:read', 'bills:read', 'accounts:read'];

interface World {
  org: AccountingOrg;
  token: string;
  integrationId: string;
  customerIds: string[];
  vendorIds: string[];
  itemIds: string[];
  invoiceId: string;
  draftInvoiceId: string;
  billId: string;
}

async function tokenFor(client: TestClient, scopes: string[], name = randomUUID().slice(0, 8)) {
  const created = await client.post('/api-integrations', { name: `Int ${name}`, scopes });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const token = await client.post(`/api-integrations/${created.body.data.id}/tokens`, {
    name: 'Prod',
  });
  expect(token.status, JSON.stringify(token.body)).toBe(201);
  return {
    token: token.body.data.token as string,
    tokenId: token.body.data.id as string,
    integrationId: created.body.data.id as string,
    version: created.body.data.version as number,
  };
}

async function world(options: { customers?: number } = {}): Promise<World> {
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
    defaultTaxTreatment: 'no_tax',
    defaultPaymentTermsDays: 30,
  });
  expect(purchases.status, JSON.stringify(purchases.body)).toBe(200);
  const customerIds: string[] = [];
  for (let i = 0; i < (options.customers ?? 3); i += 1) {
    const res = await org.owner.post('/customers', {
      party: { kind: 'organization', displayName: `Customer ${i}`, email: `c${i}@example.test` },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    customerIds.push(res.body.data.id);
  }
  const vendorIds: string[] = [];
  for (let i = 0; i < 2; i += 1) {
    const res = await org.owner.post('/vendors', {
      party: { kind: 'organization', displayName: `Vendor ${i}` },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    vendorIds.push(res.body.data.id);
  }
  const itemIds: string[] = [];
  for (let i = 0; i < 2; i += 1) {
    const res = await org.owner.post('/sales/items', {
      name: `Item ${i}`,
      itemType: 'service',
      unitPrice: '50',
      revenueAccountId: org.accounts['4100'],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    itemIds.push(res.body.data.id);
  }
  const draft = await org.owner.post('/sales/invoices', {
    customerId: customerIds[0],
    invoiceDate: '2026-03-10',
    lines: [{ itemId: itemIds[0], description: 'Dive', quantity: '2', unitPrice: '50' }],
  });
  expect(draft.status, JSON.stringify(draft.body)).toBe(201);
  const issued = await org.owner.post(`/sales/invoices/${draft.body.data.id}/issue`, {
    version: draft.body.data.version,
  });
  expect(issued.status, JSON.stringify(issued.body)).toBe(200);
  const second = await org.owner.post('/sales/invoices', {
    customerId: customerIds[0],
    invoiceDate: '2026-03-11',
    lines: [{ description: 'Boat', quantity: '1', unitPrice: '10' }],
  });
  const billDraft = await org.owner.post('/purchases/bills', {
    vendorId: vendorIds[0],
    billDate: '2026-03-10',
    vendorReference: `SI-${randomUUID().slice(0, 8)}`,
    lines: [{ description: 'Fuel', quantity: '1', unitPrice: '100', taxCodeId: null }],
  });
  expect(billDraft.status, JSON.stringify(billDraft.body)).toBe(201);
  const posted = await org.owner.post(`/purchases/bills/${billDraft.body.data.id}/post`, {
    version: billDraft.body.data.version,
  });
  expect(posted.status, JSON.stringify(posted.body)).toBe(200);
  const credentials = await tokenFor(org.owner, ALL_READ);
  return {
    org,
    token: credentials.token,
    integrationId: credentials.integrationId,
    customerIds,
    vendorIds,
    itemIds,
    invoiceId: issued.body.data.id,
    draftInvoiceId: second.body.data.id,
    billId: posted.body.data.id,
  };
}

async function call(
  path: string,
  options: {
    token?: string | null;
    headers?: Record<string, string>;
    ip?: string;
    method?: string;
  } = {},
) {
  const headers: Record<string, string> = { ...options.headers };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  const res = await ctx.app.inject({
    method: (options.method ?? 'GET') as 'GET',
    url: `/public/v1${path}`,
    headers,
    remoteAddress: options.ip ?? uniqueIp(),
  });
  let body: any;
  try {
    body = res.json();
  } catch {
    body = res.body;
  }
  return { status: res.statusCode, body, headers: res.headers };
}

let shared: World;
let other: World;
beforeAll(async () => {
  shared = await world({ customers: 7 });
  other = await world({ customers: 2 });
});

// ---------------------------------------------------------------------------
// Authentication and routing
// ---------------------------------------------------------------------------

describe('public API authentication', () => {
  it('authenticates only with a bearer token, never with a browser session', async () => {
    const withToken = await call('/customers', { token: shared.token });
    expect(withToken.status).toBe(200);
    const session = shared.org.owner.sessionToken!;
    const cookie = `${ctx.config.session.cookieName}=${session}`;
    for (const res of [
      await call('/customers', { headers: { cookie } }),
      await call('/customers', {
        headers: { cookie, 'x-csrf-token': shared.org.owner.csrfToken ?? '' },
      }),
      await call('/customers', { token: 'itk_aaaaaaaa_bad', headers: { cookie } }),
      await call(`/customers?access_token=${shared.token}`),
    ]) {
      expect(res.status).toBe(401);
      expect(res.body.error).toMatchObject({ type: 'authentication_error', code: 'invalid_token' });
    }
    // And the internal API never accepts a token.
    const internal = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/customers',
      headers: { authorization: `Bearer ${shared.token}` },
    });
    expect(internal.statusCode).toBe(401);
    expect(internal.json().error.requestId).toBeDefined(); // the internal envelope, not the public one
  });

  it('answers every credential problem with the same generic 401', async () => {
    const w = await world({ customers: 1 });
    const second = await tokenFor(w.org.owner, ['customers:read']);
    const revoked = await tokenFor(w.org.owner, ['customers:read']);
    await w.org.owner.post(`/api-tokens/${revoked.tokenId}/revoke`, { reason: 'Leaked' });
    const disabled = await tokenFor(w.org.owner, ['customers:read']);
    await w.org.owner.post(`/api-integrations/${disabled.integrationId}/disable`, {
      version: disabled.version,
      reason: 'Paused',
    });
    const short = await w.org.owner.post(`/api-integrations/${second.integrationId}/tokens`, {
      name: 'Short',
      expiresInDays: 1,
    });
    const wrongSecret = `${w.token.slice(0, -1)}${w.token.endsWith('a') ? 'b' : 'a'}`;
    const attempts = [
      await call('/customers'),
      await call('/customers', { token: 'garbage' }),
      await call('/customers', { token: `itk_zzzzzzzz_${'A'.repeat(43)}` }),
      await call('/customers', { token: wrongSecret }),
      await call('/customers', { token: revoked.token }),
      await call('/customers', { token: disabled.token }),
    ];
    ctx.clock.advance(2 * DAY);
    attempts.push(await call('/customers', { token: short.body.data.token }));
    const shapes = new Set(
      attempts.map((a) => {
        expect(a.status).toBe(401);
        expect(a.headers['www-authenticate']).toBe('Bearer');
        const { request_id: _ignored, ...rest } = a.body.error;
        return JSON.stringify(rest);
      }),
    );
    expect(shapes.size).toBe(1);
    const reasons = (
      await sql(
        `SELECT metadata->>'reason' AS reason FROM security_events
          WHERE event_type = 'api_token.auth_failed' AND organization_id = $1`,
        [w.org.organizationId],
      )
    ).rows.map((r) => r.reason);
    expect(reasons).toEqual(
      expect.arrayContaining(['bad_secret', 'revoked', 'integration_disabled', 'expired']),
    );
    expect(JSON.stringify(attempts.map((a) => a.body))).not.toContain(w.token);
  });

  it('exposes only the versioned namespace and answers unknown paths in its own contract', async () => {
    const missing = await call('/nothing-here', { token: shared.token });
    expect(missing.status).toBe(404);
    expect(Object.keys(missing.body)).toEqual(['error']);
    expect(missing.body.error).toMatchObject({ type: 'not_found', code: 'resource_not_found' });
    // A read-only token cannot use the D1 draft writes (Step 4) ...
    const write = await call('/customers', { token: shared.token, method: 'POST' });
    expect(write.status).toBe(403);
    // ... and no other resource has a write endpoint at all.
    const vendorWrite = await call('/vendors', { token: shared.token, method: 'POST' });
    expect(vendorWrite.status).toBe(404);
    const unversioned = await ctx.app.inject({ method: 'GET', url: '/public/customers' });
    expect(unversioned.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Resource authorization
// ---------------------------------------------------------------------------

describe('public API authorization', () => {
  it('requires the scope of each resource', async () => {
    const w = await world({ customers: 1 });
    const byScope: Record<string, string> = {
      'customers:read': '/customers',
      'vendors:read': '/vendors',
      'invoices:read': '/invoices',
      'bills:read': '/bills',
      'accounts:read': '/accounts',
    };
    const everything = Object.values(byScope);
    for (const [scope, allowed] of Object.entries(byScope)) {
      const { token } = await tokenFor(w.org.owner, [scope], scope.replace(':', '-'));
      for (const path of everything) {
        const res = await call(path, { token });
        if (path === allowed) expect(res.status, `${scope} ${path}`).toBe(200);
        else {
          expect(res.status, `${scope} ${path}`).toBe(403);
          expect(res.body.error).toMatchObject({ type: 'permission_error' });
        }
      }
    }
  });

  it('gives a write scope no public read access, and exposes no item endpoint at all', async () => {
    const w = await world({ customers: 1 });
    const { token: writer } = await tokenFor(w.org.owner, ['items:write'], 'items-write');
    const { token: reader } = await tokenFor(
      w.org.owner,
      ['invoices:read', 'bills:read'],
      'docs-read',
    );
    for (const path of ['/customers', '/vendors', '/invoices', '/bills', '/accounts']) {
      expect((await call(path, { token: writer })).status, path).toBe(403);
    }
    // Items are not a v1 public read resource: no scope reaches them.
    for (const token of [writer, reader, w.token]) {
      for (const path of ['/items', `/items/${w.itemIds[0]}`]) {
        const res = await call(path, { token });
        expect(res.status, path).toBe(404);
        expect(res.body.error).toMatchObject({ type: 'not_found', code: 'resource_not_found' });
      }
    }
  });

  it('evaluates the current non-Owner organization boundary on every request', async () => {
    const w = await world({ customers: 1 });
    const { token } = await tokenFor(w.org.owner, ['customers:read']);
    expect((await call('/customers', { token })).status).toBe(200);
    const roles = (await w.org.owner.get('/organizations/current/roles')).body.data as {
      id: string;
      name: string;
      description: string;
      isOwner: boolean;
      permissionKeys: string[];
    }[];
    const holders = roles.filter((r) => !r.isOwner && r.permissionKeys.includes('customers.view'));
    expect(holders.length).toBeGreaterThan(0);
    for (const r of holders) {
      await w.org.owner.put(`/organizations/current/roles/${r.id}`, {
        name: r.name,
        description: r.description,
        permissionKeys: r.permissionKeys.filter((k) => k !== 'customers.view'),
      });
    }
    // The Owner role still holds customers.view, but is not the boundary.
    const denied = await call('/customers', { token });
    expect(denied.status).toBe(403);
    expect((await call('/vendors', { token })).status).toBe(403);
    for (const r of holders) {
      await w.org.owner.put(`/organizations/current/roles/${r.id}`, {
        name: r.name,
        description: r.description,
        permissionKeys: r.permissionKeys,
      });
    }
    expect((await call('/customers', { token })).status).toBe(200);
  });

  it('does not use the permissions of the creator or the responsible administrator', async () => {
    const w = await world({ customers: 1 });
    const admin = await joinWithRole(ctx, w.org.owner, 'Administrator');
    const created = await tokenFor(admin.client, ['customers:read']);
    await w.org.owner.patch(`/organizations/current/members/${admin.membershipId}`, {
      status: 'disabled',
    });
    expect((await call('/customers', { token: created.token })).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------

describe('public API tenant isolation', () => {
  it('serves only the organization of the token', async () => {
    const mine = await call('/customers?limit=100', { token: shared.token });
    const theirs = await call('/customers?limit=100', { token: other.token });
    const mineIds = mine.body.data.map((c: { id: string }) => c.id);
    const theirIds = theirs.body.data.map((c: { id: string }) => c.id);
    expect(mineIds.sort()).toEqual([...shared.customerIds].sort());
    expect(theirIds.sort()).toEqual([...other.customerIds].sort());
    for (const id of other.customerIds) expect(mineIds).not.toContain(id);
  });

  it('answers a foreign id exactly like a missing one', async () => {
    const pairs: [string, string][] = [
      ['/customers', other.customerIds[0]!],
      ['/vendors', other.vendorIds[0]!],
      ['/invoices', other.invoiceId],
      ['/bills', other.billId],
      ['/accounts', Object.values(other.org.accounts)[0]!],
    ];
    for (const [path, foreignId] of pairs) {
      const foreign = await call(`${path}/${foreignId}`, { token: shared.token });
      const missing = await call(`${path}/${randomUUID()}`, { token: shared.token });
      expect(foreign.status, path).toBe(404);
      const strip = (r: { body: { error: { request_id: string } } }) => {
        const { request_id: _r, ...rest } = r.body.error;
        return rest;
      };
      expect(strip(foreign)).toEqual(strip(missing));
    }
  });

  it('keeps row level security authoritative for the integration role', async () => {
    const app = await connectAs('app');
    try {
      await app.query('BEGIN');
      await app.query(`SELECT set_config('app.organization_id', $1, true)`, [
        other.org.organizationId,
      ]);
      for (const table of ['customers', 'vendors', 'sales_invoices', 'purchases_bills']) {
        const rows = await app.query(`SELECT organization_id FROM ${table}`);
        expect(
          rows.rows.every((r) => r.organization_id === other.org.organizationId),
          table,
        ).toBe(true);
      }
    } finally {
      await app.query('ROLLBACK');
      await app.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Resources and DTO exposure
// ---------------------------------------------------------------------------

/** Every property name in a JSON value (the contract is about fields, not values). */
function allKeys(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => allKeys(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      allKeys(v, out);
    }
  }
  return out;
}
const leaks = (value: unknown) => [...allKeys(value)].filter((k) => FORBIDDEN.test(k));

const FORBIDDEN =
  /journal|password|secret|hash|base_|exchange|tax_code|tax_snapshot|account_id|dimension|created_by|updated_by|organization_id|service_user|membership|render|session|accounting_event|rls/i;

describe('public API resources', () => {
  it('lists and fetches customers and vendors with the public shape', async () => {
    const list = await call('/customers', { token: shared.token });
    expect(list.body.page).toEqual({ next_cursor: null, has_more: false });
    expect(Object.keys(list.body.data[0]).sort()).toEqual(
      [
        'company_name',
        'created_at',
        'credit_limit',
        'currency_code',
        'email',
        'identity_version',
        'id',
        'kind',
        'name',
        'payment_terms_days',
        'phone',
        'reference',
        'status',
        'tin',
        'updated_at',
        'version',
        'website',
      ].sort(),
    );
    const one = await call(`/customers/${shared.customerIds[0]}`, { token: shared.token });
    expect(one.body.data).toMatchObject({
      id: shared.customerIds[0],
      name: 'Customer 0',
      email: 'c0@example.test',
      status: 'ACTIVE',
    });
    const vendors = await call('/vendors', { token: shared.token });
    expect(vendors.body.data).toHaveLength(2);
    expect(Object.keys(vendors.body.data[0])).toContain('account_number');
    expect(
      (await call(`/vendors/${shared.vendorIds[1]}`, { token: shared.token })).body.data.name,
    ).toBe('Vendor 1');
    expect(leaks([list.body, one.body, vendors.body])).toEqual([]);
  });

  it('shows invoices with money in the document currency and lines only on the detail', async () => {
    const list = await call('/invoices', { token: shared.token });
    expect(list.body.data).toHaveLength(2);
    const issued = list.body.data.find((i: { id: string }) => i.id === shared.invoiceId);
    expect(issued).toMatchObject({
      status: 'ISSUED',
      customer_id: shared.customerIds[0],
      invoice_date: '2026-03-10',
      currency_code: 'MVR',
      subtotal: '100.00',
      total: '100.00',
      amount_due: '100.00',
    });
    expect(issued.number).toMatch(/^INV-/);
    expect('lines' in issued).toBe(false);
    const draft = list.body.data.find((i: { id: string }) => i.id === shared.draftInvoiceId);
    expect(draft).toMatchObject({ status: 'DRAFT', number: null, issued_at: null });
    const detail = await call(`/invoices/${shared.invoiceId}`, { token: shared.token });
    expect(detail.body.data.lines).toHaveLength(1);
    expect(Object.keys(detail.body.data.lines[0]).sort()).toEqual(
      [
        'description',
        'discount',
        'item_id',
        'line_no',
        'net_amount',
        'quantity',
        'tax_amount',
        'tax_rate',
        'total',
        'unit_price',
      ].sort(),
    );
    expect(detail.body.data.lines[0]).toMatchObject({
      quantity: '2',
      unit_price: '50',
      total: '100.00',
    });
    expect(leaks([list.body, detail.body])).toEqual([]);
    const byStatus = await call('/invoices?status=ISSUED', { token: shared.token });
    expect(byStatus.body.data.map((i: { id: string }) => i.id)).toEqual([shared.invoiceId]);
    const byCustomer = await call(`/invoices?customer_id=${shared.customerIds[1]}`, {
      token: shared.token,
    });
    expect(byCustomer.body.data).toEqual([]);
    const byDate = await call('/invoices?date_from=2026-03-11&date_to=2026-03-31', {
      token: shared.token,
    });
    expect(byDate.body.data.map((i: { id: string }) => i.id)).toEqual([shared.draftInvoiceId]);
  });

  it('shows bills with the supplier reference and lines on the detail', async () => {
    const list = await call('/bills', { token: shared.token });
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({
      id: shared.billId,
      status: 'POSTED',
      vendor_id: shared.vendorIds[0],
      total: '100.00',
      amount_due: '100.00',
    });
    expect(list.body.data[0].vendor_reference).toMatch(/^SI-/);
    expect(Object.keys(list.body.data[0]).sort()).toEqual(
      [
        'amount_due',
        'bill_date',
        'created_at',
        'currency_code',
        'discount_total',
        'due_date',
        'id',
        'memo',
        'number',
        'posted_at',
        'status',
        'subtotal',
        'tax_total',
        'tax_treatment',
        'total',
        'updated_at',
        'vendor_id',
        'vendor_reference',
        'version',
        'voided_at',
      ].sort(),
    );
    const detail = await call(`/bills/${shared.billId}`, { token: shared.token });
    expect(detail.body.data.lines).toHaveLength(1);
    expect(leaks([list.body, detail.body])).toEqual([]);
    expect(
      (await call(`/bills?vendor_id=${shared.vendorIds[1]}`, { token: shared.token })).body.data,
    ).toEqual([]);
  });

  it('lists the chart of accounts', async () => {
    const list = await call('/accounts?limit=100', { token: shared.token });
    expect(list.status).toBe(200);
    expect(list.body.data.length).toBeGreaterThan(20);
    const cash = list.body.data.find((a: { code: string }) => a.code === '1110');
    expect(cash).toMatchObject({
      name: 'Cash on Hand',
      type: 'ASSET',
      subtype: 'CASH',
      status: 'ACTIVE',
    });
    expect(Object.keys(cash).sort()).toEqual(
      [
        'code',
        'created_at',
        'currency_code',
        'description',
        'id',
        'name',
        'parent_id',
        'status',
        'subtype',
        'type',
        'updated_at',
      ].sort(),
    );
    expect(
      (await call(`/accounts?type=REVENUE&limit=100`, { token: shared.token })).body.data.every(
        (a: { type: string }) => a.type === 'REVENUE',
      ),
    ).toBe(true);
    expect((await call(`/accounts/${cash.id}`, { token: shared.token })).body.data.code).toBe(
      '1110',
    );
    expect(leaks(list.body)).toEqual([]);
  });

  it('filters by updated_since', async () => {
    const future = new Date(Date.now() + 10 * DAY).toISOString();
    expect(
      (
        await call(`/customers?updated_since=${encodeURIComponent(future)}`, {
          token: shared.token,
        })
      ).body.data,
    ).toEqual([]);
    const past = new Date(Date.now() - 10 * DAY).toISOString();
    expect(
      (await call(`/customers?updated_since=${encodeURIComponent(past)}`, { token: shared.token }))
        .body.data,
    ).toHaveLength(7);
  });
});

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

describe('public API pagination', () => {
  async function allPages(path: string, token: string, limit: number) {
    const ids: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url: string = `${path}?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await call(url, { token });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      ids.push(...res.body.data.map((r: { id: string }) => r.id));
      cursor = res.body.page.next_cursor;
      expect(res.body.page.has_more).toBe(cursor !== null);
      pages += 1;
    } while (cursor);
    return { ids, pages };
  }

  it('walks every row once, in a stable order, with opaque cursors', async () => {
    const first = await allPages('/customers', shared.token, 3);
    const second = await allPages('/customers', shared.token, 3);
    expect(first.pages).toBe(3);
    expect(first.ids).toHaveLength(7);
    expect(new Set(first.ids).size).toBe(7);
    expect([...first.ids].sort()).toEqual([...shared.customerIds].sort());
    expect(first.ids).toEqual(second.ids);
    // The order is creation order.
    expect(first.ids).toEqual(shared.customerIds);
    const one = await allPages('/customers', shared.token, 100);
    expect(one).toEqual({ ids: shared.customerIds, pages: 1 });
    const page = await call('/customers?limit=3', { token: shared.token });
    expect(page.body.page.next_cursor).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(page.body.page.next_cursor).not.toContain(shared.customerIds[2]);
  });

  it('stays stable when rows are added while paging', async () => {
    const w = await world({ customers: 5 });
    const first = await call('/customers?limit=2', { token: w.token });
    const added = await w.org.owner.post('/customers', {
      party: { kind: 'organization', displayName: 'Late arrival' },
    });
    const rest: string[] = first.body.data.map((c: { id: string }) => c.id);
    let cursor: string | null = first.body.page.next_cursor;
    while (cursor) {
      const res = await call(`/customers?limit=2&cursor=${encodeURIComponent(cursor)}`, {
        token: w.token,
      });
      rest.push(...res.body.data.map((c: { id: string }) => c.id));
      cursor = res.body.page.next_cursor;
    }
    expect(new Set(rest).size).toBe(rest.length);
    expect(rest).toEqual([...w.customerIds, added.body.data.id]);
  });

  it('refuses edited, foreign and mismatched cursors and bad limits', async () => {
    const page = await call('/customers?limit=2', { token: shared.token });
    const cursor = page.body.page.next_cursor as string;
    const [body, signature] = cursor.split('.');
    const flipped = `${body}.${signature!.slice(0, -1)}${signature!.endsWith('A') ? 'B' : 'A'}`;
    const tamperedBody = `${Buffer.from(JSON.stringify({ v: 1, r: 'customers', o: shared.org.organizationId, f: '', t: '2000-01-01T00:00:00.000000Z', i: shared.customerIds[0] })).toString('base64url')}.${signature}`;
    for (const bad of [flipped, tamperedBody, 'garbage', `${body}`, `${cursor}.extra`, 'a.b']) {
      const res = await call(`/customers?limit=2&cursor=${encodeURIComponent(bad)}`, {
        token: shared.token,
      });
      expect(res.status, bad).toBe(400);
      expect(res.body.error).toMatchObject({ type: 'invalid_request', code: 'invalid_cursor' });
    }
    // Bound to its resource, its filters and its organization.
    const wrongResource = await call(`/vendors?cursor=${encodeURIComponent(cursor)}`, {
      token: shared.token,
    });
    expect(wrongResource.body.error.code).toBe('invalid_cursor');
    const wrongFilters = await call(
      `/customers?status=ACTIVE&cursor=${encodeURIComponent(cursor)}`,
      { token: shared.token },
    );
    expect(wrongFilters.body.error.code).toBe('invalid_cursor');
    const wrongTenant = await call(`/customers?cursor=${encodeURIComponent(cursor)}`, {
      token: other.token,
    });
    expect(wrongTenant.body.error.code).toBe('invalid_cursor');
    for (const query of [
      'limit=0',
      'limit=101',
      'limit=abc',
      'limit=-1',
      'offset=2',
      'page=2',
      'unknown=1',
    ]) {
      const res = await call(`/customers?${query}`, { token: shared.token });
      expect(res.status, query).toBe(400);
      expect(res.body.error.type).toBe('invalid_request');
    }
    expect((await call('/customers?limit=100', { token: shared.token })).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Error contract
// ---------------------------------------------------------------------------

describe('public API error contract', () => {
  it('uses one envelope with a request id and never leaks internals', async () => {
    const validation = await call('/customers?limit=0', { token: shared.token });
    expect(validation.status).toBe(400);
    expect(Object.keys(validation.body.error).sort()).toEqual([
      'code',
      'details',
      'message',
      'request_id',
      'type',
    ]);
    expect(validation.body.error.details[0]).toMatchObject({ field: 'limit' });
    expect(validation.body.error.request_id).toBe(validation.headers['x-request-id']);
    const bad = await call('/customers/not-a-uuid', { token: shared.token });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('validation_failed');
    // A fresh organization: earlier tests moved the shared clock past the shared owner session.
    const fresh = await world({ customers: 1 });
    const forbidden = await call('/vendors', {
      token: (await tokenFor(fresh.org.owner, ['customers:read'], 'narrow')).token,
    });
    expect(forbidden.status).toBe(403);
    expect(Object.keys(forbidden.body.error).sort()).toEqual([
      'code',
      'message',
      'request_id',
      'type',
    ]);
    for (const res of [validation, bad, forbidden]) {
      expect(JSON.stringify(res.body)).not.toMatch(
        /select |stack|pg_|relation|itk_|secret|tenant|organization/i,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

describe('public API rate limiting', () => {
  it('frozen contract: 429 with RateLimit-* and Retry-After, per token, resetting each window', async () => {
    const limited = await createTestContext({
      PUBLIC_API_READ_PER_MINUTE: '3',
      PUBLIC_API_ORGANIZATION_PER_MINUTE: '1000',
    });
    try {
      const org = await setUpAccountingOrg(limited);
      const made = await org.owner.post('/api-integrations', {
        name: 'Rate',
        scopes: ['customers:read'],
      });
      const token = (
        await org.owner.post(`/api-integrations/${made.body.data.id}/tokens`, { name: 't' })
      ).body.data.token as string;
      const hit = async () => {
        const res = await limited.app.inject({
          method: 'GET',
          url: '/public/v1/customers',
          headers: { authorization: `Bearer ${token}` },
          remoteAddress: '203.0.113.50',
        });
        return res;
      };
      const remaining = [];
      for (let i = 0; i < 3; i += 1) {
        const res = await hit();
        expect(res.statusCode).toBe(200);
        expect(res.headers['ratelimit-limit']).toBe('3');
        expect(Number(res.headers['ratelimit-reset'])).toBeGreaterThan(0);
        remaining.push(res.headers['ratelimit-remaining']);
      }
      expect(remaining).toEqual(['2', '1', '0']);
      const over = await hit();
      expect(over.statusCode).toBe(429);
      expect(over.json().error).toMatchObject({
        type: 'rate_limited',
        code: 'rate_limit_exceeded',
      });
      expect(over.headers['ratelimit-limit']).toBe('3');
      expect(over.headers['ratelimit-remaining']).toBe('0');
      expect(Number(over.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(Number(over.headers['retry-after'])).toBeLessThanOrEqual(60);
      expect(over.headers['ratelimit-reset']).toBe(over.headers['retry-after']);
      limited.clock.advance(61_000);
      expect((await hit()).statusCode).toBe(200);
      // Another token has its own counter.
      const made2 = await org.owner.post('/api-integrations', {
        name: 'Rate 2',
        scopes: ['customers:read'],
      });
      const token2 = (
        await org.owner.post(`/api-integrations/${made2.body.data.id}/tokens`, { name: 't' })
      ).body.data.token as string;
      const fresh = await limited.app.inject({
        method: 'GET',
        url: '/public/v1/customers',
        headers: { authorization: `Bearer ${token2}` },
        remoteAddress: '203.0.113.51',
      });
      expect(fresh.statusCode).toBe(200);
    } finally {
      await limited.close();
    }
  });

  it('limits an organization across its tokens', async () => {
    const limited = await createTestContext({ PUBLIC_API_ORGANIZATION_PER_MINUTE: '4' });
    try {
      const org = await setUpAccountingOrg(limited);
      const tokens: string[] = [];
      for (const name of ['a', 'b']) {
        const made = await org.owner.post('/api-integrations', {
          name,
          scopes: ['customers:read'],
        });
        tokens.push(
          (await org.owner.post(`/api-integrations/${made.body.data.id}/tokens`, { name: 't' }))
            .body.data.token,
        );
      }
      const statuses = [];
      for (let i = 0; i < 6; i += 1) {
        const res = await limited.app.inject({
          method: 'GET',
          url: '/public/v1/customers',
          headers: { authorization: `Bearer ${tokens[i % 2]}` },
          remoteAddress: '203.0.113.60',
        });
        statuses.push(res.statusCode);
      }
      expect(statuses).toEqual([200, 200, 200, 200, 429, 429]);
    } finally {
      await limited.close();
    }
  });

  it('throttles repeated failed authentication per IP', async () => {
    const limited = await createTestContext({ PUBLIC_API_FAILED_AUTH_PER_MINUTE_PER_IP: '3' });
    try {
      const org = await setUpAccountingOrg(limited);
      const made = await org.owner.post('/api-integrations', {
        name: 'Fail',
        scopes: ['customers:read'],
      });
      const good = (
        await org.owner.post(`/api-integrations/${made.body.data.id}/tokens`, { name: 't' })
      ).body.data.token as string;
      const hit = (token: string, ip: string) =>
        limited.app.inject({
          method: 'GET',
          url: '/public/v1/customers',
          headers: { authorization: `Bearer ${token}` },
          remoteAddress: ip,
        });
      const codes = [];
      for (let i = 0; i < 5; i += 1)
        codes.push((await hit('itk_zzzzzzzz_' + 'A'.repeat(43), '203.0.113.70')).statusCode);
      expect(codes).toEqual([401, 401, 401, 429, 429]);
      // Even a valid token is refused from the throttled address, but not from another.
      const refused = await hit(good, '203.0.113.70');
      expect(refused.statusCode).toBe(429);
      expect(Number(refused.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect((await hit(good, '203.0.113.71')).statusCode).toBe(200);
      limited.clock.advance(61_000);
      expect((await hit(good, '203.0.113.70')).statusCode).toBe(200);
    } finally {
      await limited.close();
    }
  });

  it('has a second, process-local implementation of the same interface', async () => {
    const limiter = new InMemoryRateLimiter(ctx.clock);
    const key = `unit:${randomUUID()}`;
    const results = [];
    for (let i = 0; i < 3; i += 1) results.push((await limiter.consume(key, 2)).allowed);
    expect(results).toEqual([true, true, false]);
    expect((await limiter.peek(key, 2)).remaining).toBe(0);
    ctx.clock.advance(61_000);
    expect((await limiter.consume(key, 2)).allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Audit and the OpenAPI contract
// ---------------------------------------------------------------------------

describe('public API audit policy', () => {
  it('writes no audit rows for ordinary reads, but records last use and failures', async () => {
    const w = await world({ customers: 1 });
    const before = (
      await sql(`SELECT count(*)::int AS n FROM audit_events WHERE organization_id = $1`, [
        w.org.organizationId,
      ])
    ).rows[0].n;
    for (const path of ['/customers', '/vendors', '/invoices', '/bills', '/accounts']) {
      expect((await call(path, { token: w.token })).status).toBe(200);
    }
    const after = (
      await sql(`SELECT count(*)::int AS n FROM audit_events WHERE organization_id = $1`, [
        w.org.organizationId,
      ])
    ).rows[0].n;
    expect(after).toBe(before);
    const used = (
      await sql(`SELECT last_used_at FROM api_tokens WHERE organization_id = $1`, [
        w.org.organizationId,
      ])
    ).rows;
    expect(used.some((r) => r.last_used_at !== null)).toBe(true);
  });
});

describe('public API OpenAPI document', () => {
  it('is served without credentials and lists the reads and the three draft writes', async () => {
    const res = await call('/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.1.0');
    const methods = Object.fromEntries(
      Object.entries(res.body.paths).map(([path, ops]) => [path, Object.keys(ops as object)]),
    );
    expect(methods).toEqual({
      '/accounts': ['get'],
      '/accounts/{id}': ['get'],
      '/bills': ['get'],
      '/bills/{id}': ['get'],
      '/customers': ['get', 'post'],
      '/customers/{id}': ['get', 'patch'],
      // No GET under /items: the frozen scope catalog has no items:read.
      '/items': ['post'],
      '/items/{id}': ['patch'],
      '/invoices': ['get', 'post'],
      '/invoices/{id}': ['get', 'put'],
      '/vendors': ['get'],
      '/vendors/{id}': ['get'],
    });
    expect(Object.keys(res.body.components.schemas).sort()).toEqual(
      [
        'Account',
        'Bill',
        'BillSummary',
        'Customer',
        'CustomerCreate',
        'CustomerUpdate',
        'Error',
        'Invoice',
        'InvoiceDraftCreate',
        'InvoiceDraftReplace',
        'InvoiceSummary',
        'ItemCreate',
        'ItemResult',
        'ItemUpdate',
        'Page',
        'Vendor',
      ].sort(),
    );
  });

  it('is built from public DTOs: no internal field, scope or route appears', async () => {
    const text = JSON.stringify(buildOpenApiDocument());
    expect(leaks(JSON.parse(text).components.schemas)).toEqual([]);
    expect(text).not.toMatch(/items:read|payments:read|journal|ledger/i);
    expect(text).toContain('RateLimit-Remaining');
  });

  it('matches the committed contract in docs/openapi/public-v1.json', () => {
    const committed = readFileSync(
      new URL('../../../docs/openapi/public-v1.json', import.meta.url),
      'utf8',
    );
    expect(JSON.parse(committed)).toEqual(JSON.parse(JSON.stringify(buildOpenApiDocument())));
  });
});
