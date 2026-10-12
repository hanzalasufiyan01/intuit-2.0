import { randomInt, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setUpAccountingOrg, type AccountingOrg } from './fixtures.js';
import { connectAs, createTestContext, type TestClient, type TestContext } from './helpers.js';

/**
 * ADR 0011 Step 4: the Public API draft write endpoints — customers, items and DRAFT invoices,
 * through the existing domain services, and nothing else. Authorization is scope ∩ platform
 * policy ∩ the current non-Owner organization boundary; creates are idempotent per integration;
 * updates are version-checked; no write ever produces a journal, a ledger effect or an accounting
 * event.
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
const uniqueIp = () => `203.0.${randomInt(0, 256)}.${randomInt(1, 255)}`;

interface World {
  org: AccountingOrg;
  customerId: string;
  itemId: string;
  issuedInvoiceId: string;
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
  };
}

async function world(): Promise<World> {
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
  const customer = await org.owner.post('/customers', {
    party: { kind: 'organization', displayName: 'Existing customer' },
  });
  expect(customer.status, JSON.stringify(customer.body)).toBe(201);
  const item = await org.owner.post('/sales/items', {
    name: 'Existing item',
    itemType: 'service',
    unitPrice: '50',
    revenueAccountId: org.accounts['4100'],
  });
  expect(item.status, JSON.stringify(item.body)).toBe(201);
  const draft = await org.owner.post('/sales/invoices', {
    customerId: customer.body.data.id,
    invoiceDate: '2026-03-10',
    lines: [{ itemId: item.body.data.id, description: 'Dive', quantity: '2', unitPrice: '50' }],
  });
  expect(draft.status, JSON.stringify(draft.body)).toBe(201);
  const issued = await org.owner.post(`/sales/invoices/${draft.body.data.id}/issue`, {
    version: draft.body.data.version,
  });
  expect(issued.status, JSON.stringify(issued.body)).toBe(200);
  return {
    org,
    customerId: customer.body.data.id,
    itemId: item.body.data.id,
    issuedInvoiceId: issued.body.data.id,
  };
}

async function call(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  options: { token?: string | null; body?: unknown; key?: string } = {},
) {
  const headers: Record<string, string> = {};
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.key) headers['idempotency-key'] = options.key;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const res = await ctx.app.inject({
    method,
    url: `/public/v1${path}`,
    headers,
    ...(options.body !== undefined ? { payload: JSON.stringify(options.body) } : {}),
    remoteAddress: uniqueIp(),
  });
  let body: any;
  try {
    body = res.json();
  } catch {
    body = res.body;
  }
  return { status: res.statusCode, body, headers: res.headers };
}

const WRITE_SCOPES = ['customers:write', 'items:write', 'invoices:write'];
const FORBIDDEN =
  /journal|password|secret|hash|base_|exchange|tax_code|tax_snapshot|account_id|dimension|created_by|updated_by|organization_id|service_user|membership|render|session|accounting_event|rls|audit|token/i;

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

const customerBody = (name = `Cust ${randomUUID().slice(0, 8)}`) => ({
  kind: 'organization',
  name,
  email: 'billing@example.test',
  currency_code: 'MVR',
  payment_terms_days: 14,
  credit_limit: '5000.00',
});

const invoiceBody = (w: World, overrides: Record<string, unknown> = {}) => ({
  customer_id: w.customerId,
  invoice_date: '2026-03-12',
  reference: 'PO-1',
  memo: 'API draft',
  lines: [
    { item_id: w.itemId, description: 'Dive', quantity: '2', unit_price: '50' },
    { description: 'Boat', quantity: '1', unit_price: '10' },
  ],
  ...overrides,
});

/** Counts of everything an accounting write would produce, for one organization. */
async function accountingFootprint(organizationId: string) {
  const count = async (table: string) =>
    (
      await sql(`SELECT count(*)::int AS n FROM ${table} WHERE organization_id = $1`, [
        organizationId,
      ])
    ).rows[0].n as number;
  return {
    journals: await count('accounting_journal_entries'),
    journalLines: await count('accounting_journal_lines'),
    accountingEvents: await count('accounting_events'),
    reversals: await count('accounting_journal_reversals'),
  };
}

async function setRoleKeys(
  w: World,
  has: string,
  change: (keys: string[]) => string[],
): Promise<() => Promise<void>> {
  const roles = (await w.org.owner.get('/organizations/current/roles')).body.data as {
    id: string;
    name: string;
    description: string;
    isOwner: boolean;
    permissionKeys: string[];
  }[];
  const holders = roles.filter((r) => !r.isOwner && r.permissionKeys.includes(has));
  expect(holders.length).toBeGreaterThan(0);
  const put = (r: (typeof holders)[number], keys: string[]) =>
    w.org.owner.put(`/organizations/current/roles/${r.id}`, {
      name: r.name,
      description: r.description,
      permissionKeys: keys,
    });
  for (const r of holders) expect((await put(r, change(r.permissionKeys))).status).toBe(200);
  return async () => {
    for (const r of holders) await put(r, r.permissionKeys);
  };
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

describe('public API customer writes', () => {
  it('creates and updates a customer through the domain service, with the public shape', async () => {
    const w = await world();
    const { token } = await tokenFor(w.org.owner, ['customers:write']);
    const created = await call('POST', '/customers', { token, body: customerBody('Acme Dive') });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const data = created.body.data;
    expect(data).toMatchObject({
      name: 'Acme Dive',
      kind: 'organization',
      email: 'billing@example.test',
      currency_code: 'MVR',
      payment_terms_days: 14,
      credit_limit: '5000.00',
      status: 'ACTIVE',
      version: 1,
    });
    expect(leaks(created.body)).toEqual([]);
    expect(created.headers['ratelimit-limit']).toBeDefined();

    const updated = await call('PATCH', `/customers/${data.id}`, {
      token,
      body: { version: 1, name: 'Acme Dive Ltd', payment_terms_days: 30, phone: '+960 777 0000' },
    });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body.data).toMatchObject({
      id: data.id,
      name: 'Acme Dive Ltd',
      payment_terms_days: 30,
      phone: '+960 777 0000',
      email: 'billing@example.test',
      version: 2,
    });
    // The web path's audit events were written, attributed to the API token.
    const audit = await sql(
      `SELECT action, actor_type, actor_token_id FROM audit_events
        WHERE organization_id = $1 AND action = 'customer.created' AND resource_id = $2`,
      [w.org.organizationId, data.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].actor_type).toBe('api_token');
    expect(audit.rows[0].actor_token_id).not.toBeNull();
  });

  it('rejects invalid payloads and fields the contract does not define', async () => {
    const w = await world();
    const { token } = await tokenFor(w.org.owner, ['customers:write']);
    const before = (
      await sql(`SELECT count(*)::int AS n FROM customers WHERE organization_id = $1`, [
        w.org.organizationId,
      ])
    ).rows[0].n;
    const bad: Record<string, unknown>[] = [
      { kind: 'organization', name: 'X', email: 'not-an-email' },
      { kind: 'robot', name: 'X' },
      { kind: 'organization', name: 'X', currency_code: 'mvr' },
      { kind: 'organization', name: 'X', currency_code: 'ZZZ' },
      { kind: 'organization', name: 'X', credit_limit: '-5' },
      { kind: 'organization', name: 'X', payment_terms_days: 9999 },
      { kind: 'organization' },
      // not part of the public contract
      { kind: 'organization', name: 'X', organization_id: randomUUID() },
      { kind: 'organization', name: 'X', party_id: randomUUID() },
      { kind: 'organization', name: 'X', status: 'ARCHIVED' },
      { kind: 'organization', name: 'X', ar_account_id: randomUUID() },
      { kind: 'organization', name: 'X', created_by: randomUUID() },
    ];
    for (const body of bad) {
      const res = await call('POST', '/customers', { token, body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.type).toBe('invalid_request');
      expect(res.body.error.code).toBe('validation_failed');
    }
    const empty = await call('PATCH', `/customers/${w.customerId}`, {
      token,
      body: { version: 1 },
    });
    expect(empty.status).toBe(400);
    const malformed = await call('POST', '/customers', { token, body: 'nope' });
    expect(malformed.status).toBe(400);
    const after = (
      await sql(`SELECT count(*)::int AS n FROM customers WHERE organization_id = $1`, [
        w.org.organizationId,
      ])
    ).rows[0].n;
    expect(after).toBe(before);
  });

  it('needs the customers:write scope, whatever other scopes the token has', async () => {
    const w = await world();
    for (const scopes of [
      ['customers:read'],
      ['invoices:write', 'items:write', 'invoices:read'],
      ['accounts:read'],
    ]) {
      const { token } = await tokenFor(w.org.owner, scopes);
      const create = await call('POST', '/customers', { token, body: customerBody() });
      expect(create.status, scopes.join()).toBe(403);
      expect(create.body.error).toMatchObject({ type: 'permission_error' });
      const update = await call('PATCH', `/customers/${w.customerId}`, {
        token,
        body: { version: 1, name: 'Hijacked' },
      });
      expect(update.status, scopes.join()).toBe(403);
    }
    const name = (
      await sql(
        `SELECT p.display_name FROM customers c JOIN parties p ON p.id = c.party_id WHERE c.id = $1`,
        [w.customerId],
      )
    ).rows[0].display_name;
    expect(name).toBe('Existing customer');
  });

  it('refuses a customer write when the organization boundary withdraws the permission', async () => {
    const w = await world();
    const { token } = await tokenFor(w.org.owner, ['customers:write']);
    const restoreCreate = await setRoleKeys(w, 'customers.create', (k) =>
      k.filter((x) => x !== 'customers.create'),
    );
    const denied = await call('POST', '/customers', { token, body: customerBody() });
    expect(denied.status).toBe(403);
    // The Owner role still holds the key but is not the boundary; update is still allowed.
    const stillUpdate = await call('PATCH', `/customers/${w.customerId}`, {
      token,
      body: { version: 1, phone: '1' },
    });
    expect(stillUpdate.status, JSON.stringify(stillUpdate.body)).toBe(200);
    await restoreCreate();
    expect((await call('POST', '/customers', { token, body: customerBody() })).status).toBe(201);

    const restoreUpdate = await setRoleKeys(w, 'customers.update', (k) =>
      k.filter((x) => x !== 'customers.update'),
    );
    const deniedUpdate = await call('PATCH', `/customers/${w.customerId}`, {
      token,
      body: { version: 2, phone: '2' },
    });
    expect(deniedUpdate.status).toBe(403);
    await restoreUpdate();
  });
});

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

describe('public API item writes', () => {
  it('creates and updates an item without creating any item read capability', async () => {
    const w = await world();
    const { token } = await tokenFor(w.org.owner, ['items:write']);
    const created = await call('POST', '/items', {
      token,
      body: { name: 'Reef pass', item_type: 'service', sku: 'REEF-1', unit_price: '120.5' },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data).toMatchObject({
      name: 'Reef pass',
      item_type: 'service',
      sku: 'REEF-1',
      unit_price: '120.50',
      is_sold: true,
      is_purchased: false,
      status: 'ACTIVE',
      version: 1,
    });
    expect(Object.keys(created.body.data).sort()).toEqual(
      [
        'id',
        'sku',
        'name',
        'item_type',
        'description',
        'unit_price',
        'is_sold',
        'is_purchased',
        'purchase_description',
        'purchase_unit_cost',
        'status',
        'version',
        'created_at',
        'updated_at',
      ].sort(),
    );
    expect(leaks(created.body)).toEqual([]);
    const id = created.body.data.id;

    const updated = await call('PATCH', `/items/${id}`, {
      token,
      body: { version: 1, unit_price: '99', description: 'Updated' },
    });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body.data).toMatchObject({
      unit_price: '99.00',
      description: 'Updated',
      sku: 'REEF-1',
      version: 2,
    });

    // There is still no way to read an item through the Public API, with any scope.
    const all = await tokenFor(w.org.owner, [
      'items:write',
      'customers:read',
      'invoices:read',
      'bills:read',
      'accounts:read',
      'vendors:read',
    ]);
    for (const path of ['/items', `/items/${id}`]) {
      const res = await call('GET', path, { token: all.token });
      expect(res.status, path).toBe(404);
      expect(res.body.error.code).toBe('resource_not_found');
    }
    expect((await call('DELETE', `/items/${id}`, { token })).status).toBe(404);
    const audit = await sql(
      `SELECT actor_type FROM audit_events WHERE organization_id = $1 AND resource_id = $2`,
      [w.org.organizationId, id],
    );
    expect(audit.rows.map((r) => r.actor_type)).toEqual(['api_token', 'api_token']);
  });

  it('validates through the domain and rejects accounting references and unknown fields', async () => {
    const w = await world();
    const { token } = await tokenFor(w.org.owner, ['items:write']);
    const bad: Record<string, unknown>[] = [
      { item_type: 'service' },
      { name: 'X', item_type: 'gizmo' },
      { name: 'X', item_type: 'service', unit_price: '-1' },
      { name: 'X', item_type: 'service', unit_price: '1.23456' },
      { name: 'X', item_type: 'service', sku: '!!bad' },
      { name: 'X', item_type: 'service', is_sold: false, is_purchased: false },
      // accounting references are not part of the v1 write contract
      { name: 'X', item_type: 'service', revenue_account_id: w.org.accounts['4100'] },
      { name: 'X', item_type: 'service', expense_account_id: w.org.accounts['5400'] },
      { name: 'X', item_type: 'service', tax_code_id: randomUUID() },
      { name: 'X', item_type: 'service', status: 'ARCHIVED' },
    ];
    for (const body of bad) {
      const res = await call('POST', '/items', { token, body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.type).toBe('invalid_request');
    }
    // A taken SKU is a conflict, not an overwrite.
    const first = await call('POST', '/items', {
      token,
      body: { name: 'A', item_type: 'product', sku: 'DUP-1' },
    });
    expect(first.status).toBe(201);
    const dup = await call('POST', '/items', {
      token,
      body: { name: 'B', item_type: 'product', sku: 'DUP-1' },
    });
    expect(dup.status).toBe(409);
    expect(dup.body.error.type).toBe('conflict');
    expect(
      (await call('PATCH', `/items/${first.body.data.id}`, { token, body: { version: 1 } })).status,
    ).toBe(400);
  });

  it('needs items:write and the organization boundary', async () => {
    const w = await world();
    for (const scopes of [
      ['customers:write'],
      ['invoices:write', 'invoices:read'],
      ['accounts:read'],
    ]) {
      const { token } = await tokenFor(w.org.owner, scopes);
      const res = await call('POST', '/items', {
        token,
        body: { name: 'X', item_type: 'service' },
      });
      expect(res.status, scopes.join()).toBe(403);
      const patch = await call('PATCH', `/items/${w.itemId}`, {
        token,
        body: { version: 1, name: 'Hijacked' },
      });
      expect(patch.status, scopes.join()).toBe(403);
    }
    const { token } = await tokenFor(w.org.owner, ['items:write']);
    const restore = await setRoleKeys(w, 'catalog.items.manage', (k) =>
      k.filter((x) => x !== 'catalog.items.manage'),
    );
    const denied = await call('POST', '/items', {
      token,
      body: { name: 'X', item_type: 'service' },
    });
    expect(denied.status).toBe(403);
    await restore();
    expect(
      (await call('POST', '/items', { token, body: { name: 'X', item_type: 'service' } })).status,
    ).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// Draft invoices
// ---------------------------------------------------------------------------

describe('public API draft invoice writes', () => {
  it('creates a DRAFT invoice with domain-calculated totals and replaces it at its version', async () => {
    const w = await world();
    const { token } = await tokenFor(w.org.owner, ['invoices:write']);
    const created = await call('POST', '/invoices', { token, body: invoiceBody(w) });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const data = created.body.data;
    expect(data).toMatchObject({
      status: 'DRAFT',
      number: null,
      customer_id: w.customerId,
      invoice_date: '2026-03-12',
      currency_code: 'MVR',
      subtotal: '110.00',
      total: '110.00',
      reference: 'PO-1',
      memo: 'API draft',
      issued_at: null,
      voided_at: null,
      version: 1,
    });
    expect(data.lines).toHaveLength(2);
    expect(data.lines[0]).toMatchObject({ item_id: w.itemId, quantity: '2', unit_price: '50' });
    expect(leaks(created.body)).toEqual([]);

    const replaced = await call('PUT', `/invoices/${data.id}`, {
      token,
      body: {
        version: 1,
        ...invoiceBody(w, {
          memo: 'Changed',
          lines: [{ description: 'Only line', quantity: '3', unit_price: '10' }],
        }),
      },
    });
    expect(replaced.status, JSON.stringify(replaced.body)).toBe(200);
    expect(replaced.body.data).toMatchObject({
      status: 'DRAFT',
      memo: 'Changed',
      total: '30.00',
      version: 2,
    });
    expect(replaced.body.data.lines).toHaveLength(1);

    const row = (
      await sql(`SELECT status, number, journal_id FROM sales_invoices WHERE id = $1`, [data.id])
    ).rows[0];
    expect(row).toEqual({ status: 'DRAFT', number: null, journal_id: null });
    const audit = await sql(
      `SELECT action, actor_type FROM audit_events WHERE resource_id = $1 ORDER BY occurred_at, action`,
      [data.id],
    );
    expect(audit.rows.map((r) => r.action).sort()).toEqual(['invoice.created', 'invoice.updated']);
    expect(audit.rows.every((r) => r.actor_type === 'api_token')).toBe(true);
  });

  it('applies the domain validations of the web path', async () => {
    const w = await world();
    const { token } = await tokenFor(w.org.owner, ['invoices:write']);
    const post = (body: unknown) => call('POST', '/invoices', { token, body });
    expect((await post(invoiceBody(w, { lines: [] }))).status).toBe(400);
    expect((await post(invoiceBody(w, { invoice_date: '12/03/2026' }))).status).toBe(400);
    expect((await post(invoiceBody(w, { currency_code: 'ZZZ' }))).status).toBe(400);
    expect(
      (
        await post(
          invoiceBody(w, { lines: [{ description: 'x', quantity: '0', unit_price: '1' }] }),
        )
      ).status,
    ).toBe(400);
    // unknown customer or item: a domain error, nothing created
    const unknownCustomer = await post(invoiceBody(w, { customer_id: randomUUID() }));
    expect([400, 404]).toContain(unknownCustomer.status);
    const unknownItem = await post(
      invoiceBody(w, { lines: [{ item_id: randomUUID(), quantity: '1', unit_price: '1' }] }),
    );
    expect([400, 404]).toContain(unknownItem.status);
    const n = (
      await sql(`SELECT count(*)::int AS n FROM sales_invoices WHERE organization_id = $1`, [
        w.org.organizationId,
      ])
    ).rows[0].n;
    expect(n).toBe(1); // only the issued fixture invoice
  });

  it('is writable only with invoices:write, and a write scope of another resource is not enough', async () => {
    const w = await world();
    const target = (
      await call('POST', '/invoices', {
        token: (await tokenFor(w.org.owner, ['invoices:write'])).token,
        body: invoiceBody(w),
      })
    ).body.data;
    for (const scopes of [
      ['invoices:read'],
      ['customers:write'],
      ['items:write'],
      ['customers:write', 'items:write', 'customers:read', 'bills:read'],
    ]) {
      const { token } = await tokenFor(w.org.owner, scopes);
      const create = await call('POST', '/invoices', { token, body: invoiceBody(w) });
      expect(create.status, scopes.join()).toBe(403);
      const replace = await call('PUT', `/invoices/${target.id}`, {
        token,
        body: { version: 1, ...invoiceBody(w, { memo: 'Hijacked' }) },
      });
      expect(replace.status, scopes.join()).toBe(403);
    }
    const memo = (await sql(`SELECT memo FROM sales_invoices WHERE id = $1`, [target.id])).rows[0]
      .memo;
    expect(memo).toBe('API draft');
    // An invoices:write token may not write customers or items either.
    const { token } = await tokenFor(w.org.owner, ['invoices:write']);
    expect((await call('POST', '/customers', { token, body: customerBody() })).status).toBe(403);
    expect(
      (await call('POST', '/items', { token, body: { name: 'X', item_type: 'service' } })).status,
    ).toBe(403);
  });

  it('refuses the organization boundary withdrawing invoice permissions', async () => {
    const w = await world();
    const { token } = await tokenFor(w.org.owner, ['invoices:write']);
    const draft = await call('POST', '/invoices', { token, body: invoiceBody(w) });
    expect(draft.status).toBe(201);
    const restoreEdit = await setRoleKeys(w, 'invoices.edit_draft', (k) =>
      k.filter((x) => x !== 'invoices.edit_draft'),
    );
    const denied = await call('PUT', `/invoices/${draft.body.data.id}`, {
      token,
      body: { version: 1, ...invoiceBody(w, { memo: 'No' }) },
    });
    expect(denied.status).toBe(403);
    await restoreEdit();
    const restoreCreate = await setRoleKeys(w, 'invoices.create', (k) =>
      k.filter((x) => x !== 'invoices.create'),
    );
    expect((await call('POST', '/invoices', { token, body: invoiceBody(w) })).status).toBe(403);
    await restoreCreate();
  });

  it('exposes no way to issue, post, approve, void, refund, receive payment or touch the ledger', async () => {
    const w = await world();
    const { token } = await tokenFor(w.org.owner, [...WRITE_SCOPES, 'invoices:read']);
    const id = w.issuedInvoiceId;
    const attempts: [string, string, unknown?][] = [
      ['POST', `/invoices/${id}/issue`, { version: 1 }],
      ['POST', `/invoices/${id}/post`, { version: 1 }],
      ['POST', `/invoices/${id}/approve`, { version: 1 }],
      ['POST', `/invoices/${id}/submit`, { version: 1 }],
      ['POST', `/invoices/${id}/void`, { version: 1, reason: 'x' }],
      ['POST', `/invoices/${id}/refund`, { amount: '1' }],
      ['POST', `/invoices/${id}/receipts`, { amount: '1' }],
      ['POST', `/invoices/${id}/receipt`, { amount: '1' }],
      ['DELETE', `/invoices/${id}`],
      ['PATCH', `/invoices/${id}`, { version: 1, memo: 'x' }],
      ['POST', '/receipts', { amount: '1' }],
      ['POST', '/refunds', { amount: '1' }],
      ['POST', '/journals', { lines: [] }],
      ['POST', '/journal-entries', { lines: [] }],
      ['POST', '/ledger', {}],
      ['POST', '/payments', {}],
      ['POST', '/bills', {}],
      ['POST', '/vendors', {}],
      ['POST', '/accounts', {}],
      ['PATCH', `/accounts/${w.org.accounts['4100']}`, {}],
      ['PATCH', `/vendors/${randomUUID()}`, {}],
      ['PUT', `/customers/${w.customerId}`, {}],
      ['DELETE', `/customers/${w.customerId}`],
    ];
    for (const [method, path, body] of attempts) {
      const res = await call(method as 'POST', path, {
        token,
        ...(body !== undefined && { body }),
      });
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(res.body.error).toMatchObject({ type: 'not_found', code: 'resource_not_found' });
    }
    const row = (await sql(`SELECT status, version FROM sales_invoices WHERE id = $1`, [id]))
      .rows[0];
    expect(row).toMatchObject({ status: 'ISSUED' });
  });

  it('rejects status, kind, accounting and dimension fields in an invoice body', async () => {
    const w = await world();
    const { token } = await tokenFor(w.org.owner, ['invoices:write']);
    const forbidden: Record<string, unknown>[] = [
      { status: 'ISSUED' },
      { kind: 'opening' },
      { opening_base_total: '100' },
      { number: 'INV-1' },
      { journal_id: randomUUID() },
      { issued_at: '2026-03-12T00:00:00.000Z' },
      { dimension_value_ids: [randomUUID()] },
      { amount_due: '0' },
      { exchange_rate: '1' },
      { organization_id: randomUUID() },
      { tax_total: '0' },
      { total: '1' },
      {
        lines: [
          {
            description: 'x',
            quantity: '1',
            unit_price: '1',
            revenue_account_id: w.org.accounts['4100'],
          },
        ],
      },
      { lines: [{ description: 'x', quantity: '1', unit_price: '1', tax_code_id: randomUUID() }] },
      { lines: [{ description: 'x', quantity: '1', unit_price: '1', net_amount: '1' }] },
    ];
    for (const extra of forbidden) {
      const res = await call('POST', '/invoices', { token, body: invoiceBody(w, extra) });
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
    const created = await call('POST', '/invoices', { token, body: invoiceBody(w) });
    for (const extra of [{ status: 'ISSUED' }, { kind: 'opening' }]) {
      const res = await call('PUT', `/invoices/${created.body.data.id}`, {
        token,
        body: { version: 1, ...invoiceBody(w, extra) },
      });
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
    const row = (
      await sql(`SELECT status, kind FROM sales_invoices WHERE id = $1`, [created.body.data.id])
    ).rows[0];
    expect(row).toEqual({ status: 'DRAFT', kind: 'standard' });
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------

describe('public API write tenant isolation', () => {
  it('cannot write into, or reference, another organization', async () => {
    const mine = await world();
    const theirs = await world();
    const { token } = await tokenFor(mine.org.owner, WRITE_SCOPES);
    const theirCounts = async () =>
      (
        await sql(
          `SELECT (SELECT count(*) FROM customers WHERE organization_id = $1)::int AS customers,
                  (SELECT count(*) FROM sales_items WHERE organization_id = $1)::int AS items,
                  (SELECT count(*) FROM sales_invoices WHERE organization_id = $1)::int AS invoices,
                  (SELECT string_agg(version::text, ',') FROM sales_items WHERE organization_id = $1) AS item_versions,
                  (SELECT string_agg(version::text, ',') FROM customers WHERE organization_id = $1) AS customer_versions`,
          [theirs.org.organizationId],
        )
      ).rows[0];
    const before = await theirCounts();

    // Updates of foreign resources answer exactly like missing ones.
    const missing = randomUUID();
    const pairs: [string, string, Record<string, unknown>][] = [
      ['PATCH', '/customers', { version: 1, name: 'Hijack' }],
      ['PATCH', '/items', { version: 1, name: 'Hijack' }],
      ['PUT', '/invoices', { version: 1, ...invoiceBody(mine, { memo: 'Hijack' }) }],
    ];
    const foreignId = {
      '/customers': theirs.customerId,
      '/items': theirs.itemId,
      '/invoices': theirs.issuedInvoiceId,
    } as Record<string, string>;
    const strip = (r: { body: { error: { request_id: string } } }) => {
      const { request_id: _r, ...rest } = r.body.error;
      return rest;
    };
    for (const [method, path, body] of pairs) {
      const foreign = await call(method as 'PATCH', `${path}/${foreignId[path]}`, { token, body });
      const absent = await call(method as 'PATCH', `${path}/${missing}`, { token, body });
      expect(foreign.status, path).toBe(404);
      expect(strip(foreign)).toEqual(strip(absent));
    }
    // A draft on my side that names their customer or item is refused.
    const withTheirCustomer = await call('POST', '/invoices', {
      token,
      body: invoiceBody(mine, { customer_id: theirs.customerId }),
    });
    expect([400, 404]).toContain(withTheirCustomer.status);
    const withTheirItem = await call('POST', '/invoices', {
      token,
      body: invoiceBody(mine, {
        lines: [{ item_id: theirs.itemId, quantity: '1', unit_price: '1' }],
      }),
    });
    expect([400, 404]).toContain(withTheirItem.status);
    expect(await theirCounts()).toEqual(before);
    // Their invoice is untouched.
    const memo = (
      await sql(`SELECT memo FROM sales_invoices WHERE id = $1`, [theirs.issuedInvoiceId])
    ).rows[0].memo;
    expect(memo).not.toBe('Hijack');
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe('public API write idempotency', () => {
  it('replays the first response for the same key and request, per create operation', async () => {
    const w = await world();
    const { token } = await tokenFor(w.org.owner, WRITE_SCOPES);
    const cases: [string, string, unknown, string][] = [
      ['/customers', 'customers', customerBody('Replay Customer'), 'customers'],
      [
        '/items',
        'items',
        { name: 'Replay item', item_type: 'service', sku: 'RP-1' },
        'sales_items',
      ],
      ['/invoices', 'invoices', invoiceBody(w, { memo: 'replay' }), 'sales_invoices'],
    ];
    for (const [path, , body, table] of cases) {
      const key = `idem-${randomUUID()}`;
      const before = (
        await sql(`SELECT count(*)::int AS n FROM ${table} WHERE organization_id = $1`, [
          w.org.organizationId,
        ])
      ).rows[0].n;
      const first = await call('POST', path, { token, body, key });
      expect(first.status, path).toBe(201);
      expect(first.headers['idempotent-replayed']).toBeUndefined();
      const again = await call('POST', path, { token, body, key });
      expect(again.status, path).toBe(201);
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(again.body).toEqual(first.body);
      const after = (
        await sql(`SELECT count(*)::int AS n FROM ${table} WHERE organization_id = $1`, [
          w.org.organizationId,
        ])
      ).rows[0].n;
      expect(after, path).toBe(before + 1);
      // a different request with the same key is a conflict and creates nothing
      const different =
        path === '/customers'
          ? customerBody('Another')
          : path === '/items'
            ? { name: 'Replay item 2', item_type: 'service' }
            : invoiceBody(w, { memo: 'different' });
      const conflict = await call('POST', path, { token, body: different, key });
      expect(conflict.status, path).toBe(409);
      expect(conflict.body.error).toMatchObject({ type: 'conflict', code: 'idempotency_conflict' });
      const final = (
        await sql(`SELECT count(*)::int AS n FROM ${table} WHERE organization_id = $1`, [
          w.org.organizationId,
        ])
      ).rows[0].n;
      expect(final, path).toBe(before + 1);
    }
  });

  it('creates twice without a key, and rejects a malformed key', async () => {
    const w = await world();
    const { token } = await tokenFor(w.org.owner, ['customers:write']);
    const a = await call('POST', '/customers', { token, body: customerBody('Same') });
    const b = await call('POST', '/customers', { token, body: customerBody('Same') });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.data.id).not.toBe(b.body.data.id);
    const bad = await call('POST', '/customers', { token, body: customerBody(), key: 'bad key!' });
    expect(bad.status).toBe(400);
  });

  it('keeps keys private to the integration', async () => {
    const w = await world();
    const a = await tokenFor(w.org.owner, ['customers:write'], 'a');
    const b = await tokenFor(w.org.owner, ['customers:write'], 'b');
    const key = `shared-${randomUUID()}`;
    const body = customerBody('Shared key');
    const first = await call('POST', '/customers', { token: a.token, body, key });
    expect(first.status).toBe(201);
    // Integration B using the same key with the same request is NOT a replay of A's result ...
    const second = await call('POST', '/customers', { token: b.token, body, key });
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replayed']).toBeUndefined();
    expect(second.body.data.id).not.toBe(first.body.data.id);
    // ... and with a different request it cannot probe A's key (no conflict is revealed).
    const probe = await call('POST', '/customers', {
      token: b.token,
      body: customerBody('Probe'),
      key,
    });
    expect(probe.status).toBe(409);
    // (B's own key, claimed just above, with another body — never A's.)
    expect(probe.body.error.code).toBe('idempotency_conflict');
    const fresh = await call('POST', '/customers', {
      token: b.token,
      body: customerBody('Probe'),
      key: `fresh-${randomUUID()}`,
    });
    expect(fresh.status).toBe(201);
    const scopes = await sql(
      `SELECT DISTINCT scope FROM idempotency_keys WHERE organization_id = $1 AND idempotency_key = $2`,
      [w.org.organizationId, key],
    );
    expect(scopes.rows).toHaveLength(2);
    for (const r of scopes.rows)
      expect(r.scope).toMatch(/^public\.i[0-9a-f]{12}\.public\.customer\.create$/);
  });

  it('survives token rotation: the integration, not the token, owns its keys', async () => {
    const w = await world();
    const a = await tokenFor(w.org.owner, ['customers:write', 'invoices:write']);
    const key = `rotate-${randomUUID()}`;
    const body = customerBody('Rotating');
    const first = await call('POST', '/customers', { token: a.token, body, key });
    expect(first.status).toBe(201);
    const rotated = await w.org.owner.post(`/api-tokens/${a.tokenId}/rotate`, { name: 'Rotated' });
    expect(rotated.status, JSON.stringify(rotated.body)).toBe(201);
    const next = rotated.body.data.token as string;
    // The old credential is retired (rotation keeps it only for a grace period); the identity is not.
    const retired = await w.org.owner.post(`/api-tokens/${a.tokenId}/revoke`, {
      reason: 'rotated',
    });
    expect(retired.status, JSON.stringify(retired.body)).toBe(200);
    expect((await call('POST', '/customers', { token: a.token, body, key })).status).toBe(401);
    const replay = await call('POST', '/customers', { token: next, body, key });
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body).toEqual(first.body);
    expect(
      (await call('POST', '/customers', { token: next, body: customerBody('Other'), key })).status,
    ).toBe(409);
  });

  it('leaves browser idempotency unchanged and separate', async () => {
    const w = await world();
    const { token } = await tokenFor(w.org.owner, ['invoices:write']);
    const key = `browser-${randomUUID()}`;
    const web = {
      customerId: w.customerId,
      invoiceDate: '2026-03-13',
      lines: [{ description: 'Web', quantity: '1', unitPrice: '5' }],
    };
    const first = await w.org.owner.post('/sales/invoices', web, { 'idempotency-key': key });
    expect(first.status).toBe(201);
    const again = await w.org.owner.post('/sales/invoices', web, { 'idempotency-key': key });
    expect(again.status).toBe(201);
    expect(again.body.data.id).toBe(first.body.data.id);
    // The same key text in the Public API is a different namespace.
    const api = await call('POST', '/invoices', { token, body: invoiceBody(w), key });
    expect(api.status).toBe(201);
    expect(api.body.data.id).not.toBe(first.body.data.id);
  });
});

// ---------------------------------------------------------------------------
// Optimistic concurrency
// ---------------------------------------------------------------------------

describe('public API write concurrency', () => {
  it('rejects a stale update instead of overwriting, for each resource', async () => {
    const w = await world();
    const { token } = await tokenFor(w.org.owner, WRITE_SCOPES);
    const customer = (await call('POST', '/customers', { token, body: customerBody('Race') })).body
      .data;
    const item = (
      await call('POST', '/items', { token, body: { name: 'Race item', item_type: 'service' } })
    ).body.data;
    const invoice = (await call('POST', '/invoices', { token, body: invoiceBody(w) })).body.data;

    const steps: [
      string,
      string,
      string,
      Record<string, unknown>,
      (v: number) => Record<string, unknown>,
    ][] = [
      [
        'PATCH',
        `/customers/${customer.id}`,
        'customers',
        { name: 'First' },
        (v) => ({ version: v, name: 'Second' }),
      ],
      [
        'PATCH',
        `/items/${item.id}`,
        'items',
        { name: 'First' },
        (v) => ({ version: v, name: 'Second' }),
      ],
      [
        'PUT',
        `/invoices/${invoice.id}`,
        'invoices',
        invoiceBody(w, { memo: 'First' }),
        (v) => ({ version: v, ...invoiceBody(w, { memo: 'Second' }) }),
      ],
    ];
    for (const [method, path, label, first, second] of steps) {
      const ok = await call(method as 'PATCH', path, { token, body: { version: 1, ...first } });
      expect(ok.status, label).toBe(200);
      expect(ok.body.data.version, label).toBe(2);
      const stale = await call(method as 'PATCH', path, { token, body: second(1) });
      expect(stale.status, label).toBe(409);
      expect(stale.body.error).toMatchObject({ type: 'conflict', code: 'version_conflict' });
      const current = await call(method as 'PATCH', path, { token, body: second(2) });
      expect(current.status, label).toBe(200);
      expect(current.body.data.version, label).toBe(3);
    }
    const memo = (await sql(`SELECT memo FROM sales_invoices WHERE id = $1`, [invoice.id])).rows[0]
      .memo;
    expect(memo).toBe('Second');
  });

  it('makes two writers of the same customer identity conflict', async () => {
    const w = await world();
    const { token } = await tokenFor(w.org.owner, ['customers:write']);
    const c = (await call('POST', '/customers', { token, body: customerBody('Twin') })).body.data;
    const one = await call('PATCH', `/customers/${c.id}`, {
      token,
      body: { version: 1, email: 'one@example.test' },
    });
    const two = await call('PATCH', `/customers/${c.id}`, {
      token,
      body: { version: 1, email: 'two@example.test' },
    });
    expect(one.status).toBe(200);
    expect(one.body.data.version).toBe(2);
    expect(two.status).toBe(409);
    expect(two.body.error.code).toBe('version_conflict');
    const email = (
      await sql(
        `SELECT p.email FROM customers c JOIN parties p ON p.id = c.party_id WHERE c.id = $1`,
        [c.id],
      )
    ).rows[0].email;
    expect(email).toBe('one@example.test');
  });

  it('refuses to overwrite an identity edit made on the web Contacts screen', async () => {
    const w = await world();
    const { token } = await tokenFor(w.org.owner, ['customers:write', 'customers:read']);
    const created = (await call('POST', '/customers', { token, body: customerBody('Shared') })).body
      .data;
    expect(typeof created.identity_version).toBe('number');
    const partyId = (await sql(`SELECT party_id FROM customers WHERE id = $1`, [created.id]))
      .rows[0].party_id;
    const party = () =>
      sql(`SELECT display_name, phone, version FROM parties WHERE id = $1`, [partyId]).then(
        (r) => r.rows[0],
      );

    // A person edits the contact on the web; this bumps the party but not the customer version.
    const web = await w.org.owner.patch(`/parties/${partyId}`, {
      version: created.identity_version,
      phone: '+960 000',
    });
    expect(web.status, JSON.stringify(web.body)).toBe(200);

    // The API client still holds the identity_version it read: its identity write is refused ...
    const stale = await call('PATCH', `/customers/${created.id}`, {
      token,
      body: { version: created.version, identity_version: created.identity_version, name: 'API' },
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({ type: 'conflict', code: 'version_conflict' });
    // ... as is a customer-terms-only write that carries it (the check does not need identity fields).
    const staleTerms = await call('PATCH', `/customers/${created.id}`, {
      token,
      body: {
        version: created.version,
        identity_version: created.identity_version,
        payment_terms_days: 60,
      },
    });
    expect(staleTerms.status).toBe(409);
    expect(await party()).toMatchObject({ display_name: 'Shared', phone: '+960 000' });

    // After re-reading, the same change goes through with the new identity_version.
    const fresh = (await call('GET', `/customers/${created.id}`, { token })).body.data;
    expect(fresh.identity_version).toBe(created.identity_version + 1);
    expect(fresh.phone).toBe('+960 000');
    const ok = await call('PATCH', `/customers/${created.id}`, {
      token,
      body: { version: fresh.version, identity_version: fresh.identity_version, name: 'API' },
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data).toMatchObject({ name: 'API', phone: '+960 000' });
    expect(ok.body.data.identity_version).toBe(fresh.identity_version + 1);
    expect(await party()).toMatchObject({ display_name: 'API', phone: '+960 000' });

    // The web client is protected the other way round by the party version it already sends.
    const webStale = await w.org.owner.patch(`/parties/${partyId}`, {
      version: fresh.identity_version,
      phone: 'late',
    });
    expect(webStale.status).toBe(409);

    // identity_version is optional: omitting it keeps the customer-version-only guard (Step 4).
    const noToken = await call('PATCH', `/customers/${created.id}`, {
      token,
      body: { version: ok.body.data.version, payment_terms_days: 45 },
    });
    expect(noToken.status, JSON.stringify(noToken.body)).toBe(200);
    // It must be a positive integer when sent.
    const bad = await call('PATCH', `/customers/${created.id}`, {
      token,
      body: { version: noToken.body.data.version, identity_version: 0, name: 'x' },
    });
    expect(bad.status).toBe(400);
  });

  it('never edits an invoice that is no longer a draft', async () => {
    const w = await world();
    const { token } = await tokenFor(w.org.owner, ['invoices:write']);
    const before = (await sql(`SELECT * FROM sales_invoices WHERE id = $1`, [w.issuedInvoiceId]))
      .rows[0];
    const res = await call('PUT', `/invoices/${w.issuedInvoiceId}`, {
      token,
      body: { version: before.version, ...invoiceBody(w, { memo: 'Rewrite history' }) },
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ type: 'conflict', code: 'invalid_state' });
    const after = (await sql(`SELECT * FROM sales_invoices WHERE id = $1`, [w.issuedInvoiceId]))
      .rows[0];
    expect(after).toEqual(before);
    // A draft that a person has issued meanwhile cannot be edited with its old version either.
    const draft = (await call('POST', '/invoices', { token, body: invoiceBody(w) })).body.data;
    const issued = await w.org.owner.post(`/sales/invoices/${draft.id}/issue`, {
      version: draft.version,
    });
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    const late = await call('PUT', `/invoices/${draft.id}`, {
      token,
      body: { version: draft.version, ...invoiceBody(w, { memo: 'Too late' }) },
    });
    expect(late.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// Accounting integrity
// ---------------------------------------------------------------------------

describe('public API writes and accounting integrity', () => {
  it('creates no journal, ledger entry or accounting event, and leaves posted history alone', async () => {
    const w = await world();
    const { token } = await tokenFor(w.org.owner, WRITE_SCOPES);
    const posted = async () =>
      (
        await sql(
          `SELECT j.id, j.status, j.total_debit, j.total_credit, i.status AS invoice_status, i.total, i.amount_due, i.version
             FROM sales_invoices i JOIN accounting_journal_entries j ON j.id = i.journal_id
            WHERE i.id = $1`,
          [w.issuedInvoiceId],
        )
      ).rows[0];
    const footprint = await accountingFootprint(w.org.organizationId);
    const history = await posted();
    expect(history).toBeDefined();
    const balances = async () =>
      (
        await sql(
          `SELECT coalesce(sum(debit),0)::text AS debit, coalesce(sum(credit),0)::text AS credit
             FROM accounting_journal_lines WHERE organization_id = $1`,
          [w.org.organizationId],
        )
      ).rows[0];
    const ledger = await balances();

    const c = await call('POST', '/customers', { token, body: customerBody() });
    expect(c.status).toBe(201);
    expect(
      (
        await call('PATCH', `/customers/${c.body.data.id}`, {
          token,
          body: { version: 1, phone: '1' },
        })
      ).status,
    ).toBe(200);
    const i = await call('POST', '/items', {
      token,
      body: { name: 'Ledger-free', item_type: 'service' },
    });
    expect(i.status).toBe(201);
    expect(
      (
        await call('PATCH', `/items/${i.body.data.id}`, {
          token,
          body: { version: 1, unit_price: '5' },
        })
      ).status,
    ).toBe(200);
    const inv = await call('POST', '/invoices', {
      token,
      body: invoiceBody(w, { customer_id: c.body.data.id }),
    });
    expect(inv.status).toBe(201);
    expect(
      (
        await call('PUT', `/invoices/${inv.body.data.id}`, {
          token,
          body: { version: 1, ...invoiceBody(w, { customer_id: c.body.data.id, memo: 'again' }) },
        })
      ).status,
    ).toBe(200);
    // attempts that must fail do not leave accounting traces either
    expect(
      (
        await call('PUT', `/invoices/${w.issuedInvoiceId}`, {
          token,
          body: { version: 1, ...invoiceBody(w) },
        })
      ).status,
    ).toBe(409);
    expect(
      (await call('POST', `/invoices/${inv.body.data.id}/issue`, { token, body: { version: 2 } }))
        .status,
    ).toBe(404);

    expect(await accountingFootprint(w.org.organizationId)).toEqual(footprint);
    expect(await posted()).toEqual(history);
    expect(await balances()).toEqual(ledger);
    const draft = (
      await sql(`SELECT status, number, journal_id FROM sales_invoices WHERE id = $1`, [
        inv.body.data.id,
      ])
    ).rows[0];
    expect(draft).toEqual({ status: 'DRAFT', number: null, journal_id: null });
    // No accounting event was queued for any of the written documents.
    const ids = [inv.body.data.id, c.body.data.id, i.body.data.id];
    const events = await sql(
      `SELECT count(*)::int AS n FROM accounting_events
        WHERE organization_id = $1 AND (event_key = ANY($2) OR payload::text LIKE ANY($3))`,
      [w.org.organizationId, ids, ids.map((id: string) => `%${id}%`)],
    );
    expect(events.rows[0].n).toBe(0);
  });
});
