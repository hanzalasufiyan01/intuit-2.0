import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inTransaction } from '../src/application/unit-of-work.js';
import {
  claimSendSlot,
  type WebhookRequest,
  type WebhookResponse,
  type WebhookTransport,
  validateWebhookUrl,
  verifyWebhookSignature,
  WebhookDestinationError,
  WebhookTransportError,
} from '../src/modules/webhooks/index.js';
import {
  enqueueOutboxEvent,
  OutboxDispatcher,
  type OutboxEvent,
} from '../src/modules/outbox/index.js';
import { DOMAIN_PUBLIC_EVENT_TYPES, publicOutboxType } from '../src/modules/public-events/index.js';
import { AUTO_DISABLE_FAILURES } from '../src/application/webhook-delivery-service.js';
import { joinWithRole, setUpAccountingOrg, type AccountingOrg } from './fixtures.js';
import { connectAs, createTestContext, DAY, HOUR, MINUTE, type TestContext } from './helpers.js';

/**
 * ADR 0011 Step 6: webhook endpoint management, fan-out and signed delivery over the existing
 * outbox and job queue. The outbound transport is a scripted fake; every other part is real.
 */

class FakeTransport implements WebhookTransport {
  readonly requests: (WebhookRequest & { at: Date })[] = [];
  readonly script: (WebhookResponse | Error)[] = [];
  default: WebhookResponse | Error = { statusCode: 200, excerpt: '{"ok":true}', durationMs: 4 };
  /** Runs inside `send`, i.e. while the delivery job is on the network. */
  duringSend: (() => Promise<void>) | null = null;

  async checkDestination(url: string): Promise<void> {
    validateWebhookUrl(url, { allowedPorts: [443] });
    if (url.includes('blocked')) {
      throw new WebhookDestinationError(
        'blocked_address',
        'The host resolves to a private address.',
      );
    }
  }

  async send(request: WebhookRequest): Promise<WebhookResponse> {
    this.requests.push({ ...request, at: new Date() });
    await this.duringSend?.();
    const next = this.script.shift() ?? this.default;
    if (next instanceof Error) throw next;
    return next;
  }

  fail(status = 500) {
    this.default = { statusCode: status, excerpt: 'nope', durationMs: 3 };
  }
  succeed() {
    this.default = { statusCode: 200, excerpt: '{"ok":true}', durationMs: 4 };
  }
}

const transport = new FakeTransport();
const KEYS = `wh1:${Buffer.alloc(32, 7).toString('base64')}`;
let ctx: TestContext;
let owner: pg.Client;
beforeAll(async () => {
  ctx = await createTestContext(
    {
      WEBHOOK_ENCRYPTION_KEYS: KEYS,
      WEBHOOK_ENCRYPTION_ACTIVE_KEY_ID: 'wh1',
      WEBHOOK_ENDPOINT_CONCURRENCY: '10',
      WEBHOOK_ENDPOINT_MIN_INTERVAL_MS: '0',
    },
    { webhookTransport: transport },
  );
  owner = await connectAs('owner');
});
afterAll(async () => {
  await owner.end();
  await ctx.close();
});

const sql = (text: string, params: unknown[] = []) => owner.query(text, params);

interface World {
  org: AccountingOrg;
  integrationId: string;
}

async function world(scopes: string[] = ['customers:read', 'invoices:read']): Promise<World> {
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
  return { org, integrationId: await integration(org, scopes) };
}

async function integration(org: AccountingOrg, scopes: string[]) {
  const res = await org.owner.post('/api-integrations', {
    name: `Int ${randomUUID().slice(0, 8)}`,
    scopes,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.id as string;
}

async function endpoint(w: World, overrides: Record<string, unknown> = {}) {
  const res = await w.org.owner.post('/webhooks/endpoints', {
    name: `Hook ${randomUUID().slice(0, 8)}`,
    url: 'https://hooks.example.com/in',
    integrationId: w.integrationId,
    eventTypes: ['customer.created'],
    ...overrides,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as {
    id: string;
    secret: string;
    version: number;
    status: string;
    eventTypes: string[];
  };
}

async function newCustomer(w: World, name = `Cust ${randomUUID().slice(0, 6)}`) {
  const res = await w.org.owner.post('/customers', {
    party: { kind: 'organization', displayName: name },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as { id: string; version: number };
}

/** The org's public outbox rows, as the dispatcher would hand them to the fan-out. */
async function publicRows(organizationId: string): Promise<OutboxEvent[]> {
  const res = await sql(
    `SELECT * FROM outbox_events WHERE organization_id = $1 AND event_type LIKE 'public.%'
      ORDER BY created_at, id`,
    [organizationId],
  );
  return res.rows.map(
    (r) =>
      ({
        id: r.id,
        eventType: r.event_type,
        organizationId: r.organization_id,
        payload: r.payload,
      }) as unknown as OutboxEvent,
  );
}

/** Fans out every public event of the organization that has not been fanned out (idempotent). */
async function fanOutAll(organizationId: string) {
  let created = 0;
  for (const row of await publicRows(organizationId)) {
    created += (await ctx.services.webhookDelivery.fanOut(row)).created;
  }
  return created;
}

async function deliveries(organizationId: string) {
  return (
    await sql(
      `SELECT * FROM webhook_deliveries WHERE organization_id = $1 ORDER BY created_at, id`,
      [organizationId],
    )
  ).rows;
}

/**
 * The job queue is shared by every test organization and the worker claims across organizations:
 * delivery jobs left queued by earlier tests are retired so they cannot consume this test's
 * scripted responses or its worker batch.
 */
async function isolate(organizationId: string) {
  await sql(
    `UPDATE jobs SET status = 'failed', finished_at = now(), locked_at = NULL, locked_by = NULL
      WHERE type = 'webhook.deliver' AND status IN ('queued', 'running') AND organization_id <> $1`,
    [organizationId],
  );
}

/** Runs the delivery jobs of an organization until none is runnable (optionally skipping waits). */
async function drain(organizationId: string, options: { force?: boolean; rounds?: number } = {}) {
  await isolate(organizationId);
  for (let i = 0; i < (options.rounds ?? 40); i += 1) {
    if (options.force ?? true) {
      await sql(
        `UPDATE jobs SET run_after = now() - interval '1 second'
          WHERE organization_id = $1 AND type = 'webhook.deliver' AND status = 'queued'`,
        [organizationId],
      );
    }
    if ((await ctx.worker.runOnce()) === 0) return;
  }
}

const bodyOf = (r: WebhookRequest) => JSON.parse(r.body);
const nowSeconds = () => Math.floor(ctx.clock.now().getTime() / 1000);

function verifies(request: WebhookRequest, secret: string, deliveryId?: string) {
  return verifyWebhookSignature({
    secret,
    header: request.headers['intuit-webhook-signature']!,
    deliveryId: deliveryId ?? request.headers['intuit-webhook-id']!,
    rawBody: request.body,
    nowSeconds: nowSeconds(),
  });
}

async function accountingFootprint(organizationId: string) {
  return (
    await sql(
      `SELECT (SELECT count(*) FROM accounting_journal_entries WHERE organization_id = $1)::int AS journals,
              (SELECT count(*) FROM accounting_journal_lines WHERE organization_id = $1)::int AS lines,
              (SELECT count(*) FROM accounting_events WHERE organization_id = $1)::int AS events,
              (SELECT coalesce(sum(total), 0)::text FROM sales_invoices WHERE organization_id = $1) AS invoice_total`,
      [organizationId],
    )
  ).rows[0];
}

// ---------------------------------------------------------------------------
// Endpoint management: authorization, validation, secrets
// ---------------------------------------------------------------------------

describe('webhook endpoint management', () => {
  it('needs webhooks.manage to change and webhooks.view to read: members only read, administrators both', async () => {
    const w = await world();
    const member = await joinWithRole(ctx, w.org.owner, 'Member');
    // Migration 0055 (accepted) gives the Member template webhooks.view only; it cannot manage.
    expect((await member.client.get('/webhooks/endpoints')).status).toBe(200);
    expect((await member.client.get('/webhooks/event-types')).status).toBe(200);
    const refused = await member.client.post('/webhooks/endpoints', {
      name: 'x',
      url: 'https://hooks.example.com/in',
      integrationId: w.integrationId,
      eventTypes: ['customer.created'],
    });
    expect(refused.status).toBe(403);
    const admin = await joinWithRole(ctx, w.org.owner, 'Administrator');
    expect((await admin.client.get('/webhooks/endpoints')).status).toBe(200);
    const created = await admin.client.post('/webhooks/endpoints', {
      name: 'Admin hook',
      url: 'https://hooks.example.com/in',
      integrationId: w.integrationId,
      eventTypes: ['customer.created'],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    // A view-only role can read but not change.
    const role = await w.org.owner.post('/organizations/current/roles', {
      name: 'Hook viewer',
      permissionKeys: ['webhooks.view'],
    });
    expect(role.status).toBe(201);
    const viewer = await joinWithRole(ctx, w.org.owner, 'Hook viewer');
    expect((await viewer.client.get('/webhooks/endpoints')).status).toBe(200);
    expect((await viewer.client.get(`/webhooks/endpoints/${created.body.data.id}`)).status).toBe(
      200,
    );
    expect(
      (
        await viewer.client.post(`/webhooks/endpoints/${created.body.data.id}/disable`, {
          version: created.body.data.version,
        })
      ).status,
    ).toBe(403);
  });

  it('shows the signing secret once, stores it only encrypted and never logs or audits it', async () => {
    const w = await world();
    const created = await endpoint(w);
    expect(created.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    const fetched = await w.org.owner.get(`/webhooks/endpoints/${created.id}`);
    const listed = await w.org.owner.get('/webhooks/endpoints');
    for (const body of [fetched.body, listed.body]) {
      expect(JSON.stringify(body)).not.toContain(created.secret);
      expect(JSON.stringify(body)).not.toMatch(/ciphertext|secret_key|"secret"/i);
    }
    expect(Object.keys(fetched.body.data)).not.toContain('secret');
    const row = (await sql(`SELECT * FROM webhook_endpoints WHERE id = $1`, [created.id])).rows[0];
    expect(row.secret_key_id).toBe('wh1');
    expect(Buffer.from(row.secret_ciphertext).toString('utf8')).not.toContain('whsec_');
    expect(Buffer.from(row.secret_ciphertext).toString('base64')).not.toContain(
      Buffer.from(created.secret).toString('base64').slice(8, 24),
    );
    const audit = await sql(`SELECT metadata::text AS m FROM audit_events WHERE resource_id = $1`, [
      created.id,
    ]);
    expect(audit.rows.length).toBeGreaterThan(0);
    for (const r of audit.rows) expect(r.m).not.toContain(created.secret);
    expect(ctx.logs.join('\n')).not.toContain(created.secret);
    // Rotation shows the new secret once as well.
    const rotated = await w.org.owner.post(`/webhooks/endpoints/${created.id}/rotate-secret`, {
      version: created.version,
    });
    expect(rotated.status, JSON.stringify(rotated.body)).toBe(200);
    expect(rotated.body.data.secret).toMatch(/^whsec_/);
    expect(rotated.body.data.secret).not.toBe(created.secret);
    expect(rotated.headers['cache-control']).toContain('no-store');
    expect(ctx.logs.join('\n')).not.toContain(rotated.body.data.secret);
  });

  it('refuses a subscription beyond what the integration may read, and what the person may see', async () => {
    const w = await world(['customers:read']);
    const post = (body: Record<string, unknown>, client = w.org.owner) =>
      client.post('/webhooks/endpoints', {
        name: `H ${randomUUID().slice(0, 6)}`,
        url: 'https://hooks.example.com/in',
        integrationId: w.integrationId,
        eventTypes: ['customer.created'],
        ...body,
      });
    const issues = (res: { body: any }) =>
      (res.body.error.details.issues as { path: string; message: string }[]).map((i) => i.message);
    expect((await post({})).status).toBe(201);
    // The integration holds customers:read only.
    const beyond = await post({ eventTypes: ['customer.updated', 'invoice.issued'] });
    expect(beyond.status).toBe(400);
    expect(issues(beyond).join(' ')).toMatch(/invoice\.issued needs read access/);
    // No scope exists for these resources in v1: not subscribable yet.
    for (const type of [
      'item.created',
      'credit_note.issued',
      'receipt.recorded',
      'vendor_payment.recorded',
      'expense_claim.posted',
    ]) {
      const res = await post({ eventTypes: [type] });
      expect(res.status, type).toBe(400);
      expect(issues(res).join(' '), type).toMatch(/cannot be subscribed to yet/);
    }
    // Not a catalog type, not the test event, not empty.
    for (const eventTypes of [['journal.posted'], ['webhook.ping'], []]) {
      expect((await post({ eventTypes })).status, JSON.stringify(eventTypes)).toBe(400);
    }
    // A write scope is not a read scope.
    const writer = await integration(w.org, ['customers:write']);
    expect((await post({ integrationId: writer })).status).toBe(400);
    // The person must hold the resource's read permission as well.
    const role = await w.org.owner.post('/organizations/current/roles', {
      name: 'Hook only',
      permissionKeys: ['webhooks.view', 'webhooks.manage'],
    });
    expect(role.status).toBe(201);
    const hookOnly = await joinWithRole(ctx, w.org.owner, 'Hook only');
    const denied = await post({}, hookOnly.client);
    expect(denied.status, JSON.stringify(denied.body)).toBe(400);
    expect(issues(denied).join(' ')).toMatch(/do not have access/);
    // The catalog tells the client what can be subscribed to.
    const catalog = (await w.org.owner.get('/webhooks/event-types')).body.data as {
      type: string;
      subscribable: boolean;
    }[];
    expect(catalog).toHaveLength(DOMAIN_PUBLIC_EVENT_TYPES.length);
    expect(catalog.filter((c) => c.subscribable).map((c) => c.type.split('.')[0])).toEqual(
      expect.arrayContaining(['customer', 'vendor', 'invoice', 'bill']),
    );
    expect(catalog.find((c) => c.type === 'item.created')!.subscribable).toBe(false);
  });

  it('validates the destination at create and update, and an unknown or revoked integration', async () => {
    const w = await world();
    const post = (body: Record<string, unknown>) =>
      w.org.owner.post('/webhooks/endpoints', {
        name: `H ${randomUUID().slice(0, 6)}`,
        url: 'https://hooks.example.com/in',
        integrationId: w.integrationId,
        eventTypes: ['customer.created'],
        ...body,
      });
    for (const url of [
      'http://hooks.example.com/in',
      'https://127.0.0.1/in',
      'https://user:pw@hooks.example.com/in',
      'https://localhost/in',
      'https://hooks.example.com:8443/in',
      'https://blocked.example.com/in',
    ]) {
      const res = await post({ url });
      expect(res.status, url).toBe(400);
      expect(res.body.error.details.issues[0].path).toBe('url');
    }
    expect((await post({ integrationId: randomUUID() })).status).toBe(400);
    expect((await post({ unknownField: 1 })).status).toBe(400);
    expect((await post({ payloadMode: 'huge' })).status).toBe(400);
    // Update re-validates a changed destination and subscription.
    const created = await endpoint(w);
    const bad = await w.org.owner.patch(`/webhooks/endpoints/${created.id}`, {
      version: created.version,
      url: 'https://blocked.example.com/in',
    });
    expect(bad.status).toBe(400);
    const stale = await w.org.owner.patch(`/webhooks/endpoints/${created.id}`, {
      version: created.version + 5,
      name: 'Renamed',
    });
    expect(stale.status).toBe(409);
    const ok = await w.org.owner.patch(`/webhooks/endpoints/${created.id}`, {
      version: created.version,
      name: 'Renamed',
      eventTypes: ['customer.created', 'customer.updated'],
      payloadMode: 'full',
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data).toMatchObject({
      name: 'Renamed',
      payloadMode: 'full',
      eventTypes: ['customer.created', 'customer.updated'],
      version: created.version + 1,
    });
    const beyond = await w.org.owner.patch(`/webhooks/endpoints/${created.id}`, {
      version: ok.body.data.version,
      eventTypes: ['bill.posted'],
    });
    expect(beyond.status).toBe(400);
  });

  it('allows at most 10 endpoints per organization', async () => {
    const w = await world();
    const ids: string[] = [];
    for (let i = 0; i < 10; i += 1) ids.push((await endpoint(w, { name: `Hook ${i}` })).id);
    const eleventh = await w.org.owner.post('/webhooks/endpoints', {
      name: 'Hook 11',
      url: 'https://hooks.example.com/in',
      integrationId: w.integrationId,
      eventTypes: ['customer.created'],
    });
    expect(eleventh.status).toBe(409);
    const current = (await w.org.owner.get(`/webhooks/endpoints/${ids[0]}`)).body.data;
    const removed = await w.org.owner.delete(
      `/webhooks/endpoints/${ids[0]}?version=${current.version}`,
    );
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect((await w.org.owner.get(`/webhooks/endpoints/${ids[0]}`)).status).toBe(404);
    await endpoint(w, { name: 'Hook 12' });
  });

  it('requires a recent password confirmation for changes', async () => {
    const w = await world();
    const created = await endpoint(w);
    ctx.clock.advance(16 * MINUTE);
    await w.org.owner.get('/auth/session');
    const stale = await w.org.owner.post(`/webhooks/endpoints/${created.id}/disable`, {
      version: created.version,
    });
    expect(stale.status).toBe(403);
    expect(stale.body.error.code).toBe('REAUTHENTICATION_REQUIRED');
    expect((await w.org.owner.reauthenticate()).status).toBe(200);
    const ok = await w.org.owner.post(`/webhooks/endpoints/${created.id}/disable`, {
      version: created.version,
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it('keeps organizations apart: endpoints, deliveries and redelivery are invisible across tenants', async () => {
    const a = await world();
    const b = await world();
    const hook = await endpoint(a);
    await newCustomer(a);
    await fanOutAll(a.org.organizationId);
    const [delivery] = await deliveries(a.org.organizationId);
    expect(delivery).toBeDefined();
    expect((await b.org.owner.get(`/webhooks/endpoints/${hook.id}`)).status).toBe(404);
    expect((await b.org.owner.get('/webhooks/endpoints')).body.data).toEqual([]);
    expect((await b.org.owner.get(`/webhooks/deliveries/${delivery.id}`)).status).toBe(404);
    expect((await b.org.owner.get('/webhooks/deliveries')).body.data).toEqual([]);
    expect(
      (await b.org.owner.post(`/webhooks/deliveries/${delivery.id}/redeliver`, {})).status,
    ).toBe(404);
    for (const path of ['rotate-secret', 'disable', 'enable']) {
      expect(
        (
          await b.org.owner.post(`/webhooks/endpoints/${hook.id}/${path}`, {
            version: hook.version,
          })
        ).status,
        path,
      ).toBe(404);
    }
    expect((await b.org.owner.post(`/webhooks/endpoints/${hook.id}/ping`, {})).status).toBe(404);
    expect(
      (await b.org.owner.patch(`/webhooks/endpoints/${hook.id}`, { version: 1, name: 'x' })).status,
    ).toBe(404);
    // An integration of another organization cannot back an endpoint.
    const foreign = await b.org.owner.post('/webhooks/endpoints', {
      name: 'x',
      url: 'https://hooks.example.com/in',
      integrationId: a.integrationId,
      eventTypes: ['customer.created'],
    });
    expect(foreign.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Fan-out and delivery
// ---------------------------------------------------------------------------

describe('fan-out and signed delivery', () => {
  it('delivers the frozen envelope, signed, with the delivery id and event headers', async () => {
    transport.succeed();
    const w = await world();
    const hook = await endpoint(w, { eventTypes: ['customer.created', 'customer.updated'] });
    const customer = await newCustomer(w);
    expect(await fanOutAll(w.org.organizationId)).toBe(1);
    const [pending] = await deliveries(w.org.organizationId);
    expect(pending).toMatchObject({
      status: 'pending',
      event_type: 'customer.created',
      attempts_made: 0,
    });
    transport.requests.length = 0;
    await drain(w.org.organizationId);
    const sent = transport.requests.filter((r) => r.url === 'https://hooks.example.com/in');
    expect(sent).toHaveLength(1);
    const request = sent[0]!;
    const envelope = bodyOf(request);
    expect(Object.keys(envelope).sort()).toEqual(
      ['api_version', 'data', 'id', 'occurred_at', 'organization_id', 'resource', 'type'].sort(),
    );
    expect(envelope).toMatchObject({
      type: 'customer.created',
      api_version: 'v1',
      organization_id: w.org.organizationId,
      resource: { type: 'customer', id: customer.id, version: 1 },
      data: {
        object_type: 'customer',
        object_id: customer.id,
        url: `/public/v1/customers/${customer.id}`,
      },
    });
    expect(Object.keys(envelope.data).sort()).toEqual(['object_id', 'object_type', 'url']);
    expect(envelope.id).toMatch(/^evt_/);
    expect(request.body).not.toMatch(/journal|ledger|tax_snapshot|amount|account/i);
    expect(request.headers).toMatchObject({
      'content-type': 'application/json',
      'intuit-webhook-id': pending.id,
      'intuit-webhook-event': 'customer.created',
    });
    expect(request.headers['intuit-webhook-timestamp']).toMatch(/^\d{10}$/);
    expect(request.headers['intuit-webhook-signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(verifies(request, hook.secret)).toBe(true);
    expect(verifies(request, 'whsec_other')).toBe(false);
    const [done] = await deliveries(w.org.organizationId);
    expect(done).toMatchObject({ status: 'succeeded', attempts_made: 1, last_status_code: 200 });
    expect(done.event_id).toBe(envelope.id);
    const attempts = (
      await sql(`SELECT * FROM webhook_delivery_attempts WHERE delivery_id = $1`, [pending.id])
    ).rows;
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ attempt_no: 1, status_code: 200, error_class: null });
    // The history never holds the secret or the signature.
    expect(JSON.stringify(attempts)).not.toContain(hook.secret);
    expect(JSON.stringify(attempts)).not.toContain('v1=');
    expect(
      (
        await sql(
          `SELECT consecutive_failures, last_success_at FROM webhook_endpoints WHERE id = $1`,
          [hook.id],
        )
      ).rows[0],
    ).toMatchObject({ consecutive_failures: 0 });
  });

  it('adds the public object only for full-mode endpoints', async () => {
    transport.succeed();
    const w = await world();
    await endpoint(w, { name: 'Thin', url: 'https://thin.example.com/in' });
    await endpoint(w, { name: 'Full', url: 'https://full.example.com/in', payloadMode: 'full' });
    const customer = await newCustomer(w, 'Full Mode Ltd');
    transport.requests.length = 0;
    await fanOutAll(w.org.organizationId);
    await drain(w.org.organizationId);
    const thin = bodyOf(transport.requests.find((r) => r.url.startsWith('https://thin'))!);
    const full = bodyOf(transport.requests.find((r) => r.url.startsWith('https://full'))!);
    expect(thin.data).not.toHaveProperty('object');
    expect(full.data).toMatchObject({
      object_type: 'customer',
      object_id: customer.id,
      object: { id: customer.id, name: 'Full Mode Ltd', kind: 'organization' },
    });
    // The object is the public DTO: no internal field.
    expect(JSON.stringify(full.data.object)).not.toMatch(
      /organization_id|party_id|created_by|journal/,
    );
    expect(full.id).toBe(thin.id);
  });

  it('creates nothing for unsubscribed events, other organizations, and fans out only once', async () => {
    transport.succeed();
    const a = await world();
    const b = await world();
    await endpoint(a, { eventTypes: ['customer.updated'] });
    await endpoint(b);
    const customer = await newCustomer(a);
    await newCustomer(b);
    expect(await fanOutAll(a.org.organizationId)).toBe(0); // not subscribed to customer.created
    expect(await deliveries(a.org.organizationId)).toHaveLength(0);
    // Organization B's own event reaches only B's endpoint.
    expect(await fanOutAll(b.org.organizationId)).toBe(1);
    expect(await deliveries(a.org.organizationId)).toHaveLength(0);
    // Repeated fan-out of the same outbox row (retry, second worker) creates nothing new.
    expect(await fanOutAll(b.org.organizationId)).toBe(0);
    expect(await fanOutAll(b.org.organizationId)).toBe(0);
    expect(await deliveries(b.org.organizationId)).toHaveLength(1);
    const jobs = await sql(
      `SELECT count(*)::int AS n FROM jobs WHERE organization_id = $1 AND type = 'webhook.deliver'`,
      [b.org.organizationId],
    );
    expect(jobs.rows[0].n).toBe(1);
    // An update event does reach A once A's customer changes.
    const updated = await a.org.owner.patch(`/customers/${customer.id}`, {
      version: customer.version,
      paymentTermsDays: 9,
    });
    expect(updated.status).toBe(200);
    expect(await fanOutAll(a.org.organizationId)).toBe(1);
  });

  it('retries on the frozen schedule, keeps the delivery and event id, and dead-letters after 10 attempts', async () => {
    transport.fail(500);
    const w = await world();
    const hook = await endpoint(w);
    await newCustomer(w);
    await fanOutAll(w.org.organizationId);
    const [delivery] = await deliveries(w.org.organizationId);
    transport.requests.length = 0;
    const schedule = [30, 120, 600, 1800, 3600, 10800, 21600, 43200, 86400];
    await isolate(w.org.organizationId);
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      await sql(
        `UPDATE jobs SET run_after = now() - interval '1 second'
          WHERE organization_id = $1 AND type = 'webhook.deliver' AND status = 'queued'`,
        [w.org.organizationId],
      );
      expect(await ctx.worker.runOnce()).toBeGreaterThan(0);
      const row = (await deliveries(w.org.organizationId))[0];
      expect(row.attempts_made).toBe(attempt);
      if (attempt < 10) {
        expect(row.status).toBe('pending');
        const job = (
          await sql(
            `SELECT extract(epoch FROM (run_after - now())) AS wait, attempts, status
               FROM jobs WHERE organization_id = $1 AND type = 'webhook.deliver'`,
            [w.org.organizationId],
          )
        ).rows[0];
        expect(job.status).toBe('queued');
        const expected = schedule[attempt - 1]!;
        // ±20% jitter around the frozen delay (a small allowance for the time the test takes).
        expect(Number(job.wait)).toBeGreaterThan(expected * 0.8 - 5);
        expect(Number(job.wait)).toBeLessThan(expected * 1.2 + 5);
      }
    }
    const dead = (await deliveries(w.org.organizationId))[0];
    expect(dead).toMatchObject({
      status: 'dead',
      attempts_made: 10,
      last_status_code: 500,
      last_error_class: 'http_status',
    });
    expect(dead.finished_at).not.toBeNull();
    expect(transport.requests).toHaveLength(10);
    // Every attempt names the same delivery and the same event.
    expect(new Set(transport.requests.map((r) => r.headers['intuit-webhook-id']))).toEqual(
      new Set([delivery.id]),
    );
    expect(new Set(transport.requests.map((r) => bodyOf(r).id))).toEqual(
      new Set([delivery.event_id]),
    );
    for (const r of transport.requests) expect(verifies(r, hook.secret)).toBe(true);
    const attempts = (
      await sql(
        `SELECT attempt_no, error_class, status_code, response_excerpt FROM webhook_delivery_attempts WHERE delivery_id = $1 ORDER BY attempt_no`,
        [delivery.id],
      )
    ).rows;
    expect(attempts.map((a) => a.attempt_no)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(attempts[0]).toMatchObject({
      error_class: 'http_status',
      status_code: 500,
      response_excerpt: 'nope',
    });
    // One dead delivery is one failed delivery (not ten), and the dead letter is audited.
    expect(
      (
        await sql(`SELECT consecutive_failures, status FROM webhook_endpoints WHERE id = $1`, [
          hook.id,
        ])
      ).rows[0],
    ).toMatchObject({ consecutive_failures: 1, status: 'active' });
    expect(
      (
        await sql(
          `SELECT count(*)::int AS n FROM audit_events WHERE action = 'webhook_delivery.dead_lettered' AND resource_id = $1`,
          [delivery.id],
        )
      ).rows[0].n,
    ).toBe(1);
    // The job ended as a success: nothing is left to retry.
    expect(
      (
        await sql(
          `SELECT status FROM jobs WHERE organization_id = $1 AND type = 'webhook.deliver'`,
          [w.org.organizationId],
        )
      ).rows[0].status,
    ).toBe('succeeded');
    transport.succeed();
  });

  it('classifies network failures and succeeds on a later attempt, resetting the failure count', async () => {
    const w = await world();
    const hook = await endpoint(w);
    await sql(`UPDATE webhook_endpoints SET consecutive_failures = 4 WHERE id = $1`, [hook.id]);
    await newCustomer(w);
    await fanOutAll(w.org.organizationId);
    transport.requests.length = 0;
    transport.script.push(
      new WebhookTransportError('timeout', 'x', 10_000),
      new WebhookTransportError('tls', 'x', 5),
      new WebhookDestinationError('blocked_address', 'private'),
      { statusCode: 302, excerpt: '', durationMs: 2 },
      { statusCode: 204, excerpt: '', durationMs: 2 },
    );
    transport.succeed();
    await drain(w.org.organizationId);
    const [row] = await deliveries(w.org.organizationId);
    expect(row).toMatchObject({ status: 'succeeded', attempts_made: 5, last_status_code: 204 });
    const classes = (
      await sql(
        `SELECT error_class FROM webhook_delivery_attempts WHERE delivery_id = $1 ORDER BY attempt_no`,
        [row.id],
      )
    ).rows.map((r) => r.error_class);
    expect(classes).toEqual(['timeout', 'tls', 'blocked_address', 'redirect', null]);
    expect(
      (await sql(`SELECT consecutive_failures FROM webhook_endpoints WHERE id = $1`, [hook.id]))
        .rows[0].consecutive_failures,
    ).toBe(0);
  });

  it('never makes the request inside a database transaction, and never touches accounting', async () => {
    transport.succeed();
    const w = await world();
    await endpoint(w, { eventTypes: ['customer.created', 'invoice.issued'] });
    const customer = await newCustomer(w);
    const draft = await w.org.owner.post('/sales/invoices', {
      customerId: customer.id,
      invoiceDate: '2026-03-10',
      lines: [{ description: 'Dive', quantity: '1', unitPrice: '100' }],
    });
    const issued = await w.org.owner.post(`/sales/invoices/${draft.body.data.id}/issue`, {
      version: draft.body.data.version,
    });
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    await fanOutAll(w.org.organizationId);
    expect(await deliveries(w.org.organizationId)).toHaveLength(2);
    const before = await accountingFootprint(w.org.organizationId);
    const openTransactions: number[] = [];
    transport.duringSend = async () => {
      const res = await sql(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()
            AND state IN ('idle in transaction', 'idle in transaction (aborted)')`,
      );
      openTransactions.push(res.rows[0].n);
    };
    transport.fail(503);
    await drain(w.org.organizationId, { force: false });
    transport.duringSend = null;
    expect(openTransactions.length).toBeGreaterThanOrEqual(2);
    expect(openTransactions.every((n) => n === 0)).toBe(true);
    // Failed (and successful) deliveries change nothing in the books.
    expect(await accountingFootprint(w.org.organizationId)).toEqual(before);
    transport.succeed();
    await drain(w.org.organizationId);
    expect(await accountingFootprint(w.org.organizationId)).toEqual(before);
    expect(
      (await sql(`SELECT status FROM sales_invoices WHERE id = $1`, [draft.body.data.id])).rows[0]
        .status,
    ).toBe('ISSUED');
  });
});

// ---------------------------------------------------------------------------
// Scopes, status and the re-checks
// ---------------------------------------------------------------------------

describe('authorization is re-checked at fan-out and at delivery', () => {
  it('cancels pending deliveries and stops fan-out once the scope is removed', async () => {
    transport.succeed();
    const w = await world(['customers:read']);
    await endpoint(w, { eventTypes: ['customer.created', 'customer.updated'] });
    const customer = await newCustomer(w);
    await fanOutAll(w.org.organizationId);
    expect(await deliveries(w.org.organizationId)).toHaveLength(1);
    // The scope is removed before the delivery runs.
    const current = (await w.org.owner.get(`/api-integrations/${w.integrationId}`)).body.data;
    const narrowed = await w.org.owner.patch(`/api-integrations/${w.integrationId}`, {
      version: current.version,
      scopes: ['accounts:read'],
    });
    expect(narrowed.status, JSON.stringify(narrowed.body)).toBe(200);
    transport.requests.length = 0;
    await drain(w.org.organizationId);
    expect(transport.requests).toHaveLength(0);
    expect((await deliveries(w.org.organizationId))[0]).toMatchObject({
      status: 'cancelled',
      last_error_class: 'scope_revoked',
      attempts_made: 0,
    });
    // New events create no delivery at all.
    await w.org.owner.patch(`/customers/${customer.id}`, {
      version: customer.version,
      paymentTermsDays: 3,
    });
    expect(await fanOutAll(w.org.organizationId)).toBe(0);
    expect(await deliveries(w.org.organizationId)).toHaveLength(1);
    // A cancellation is not a failed delivery.
    expect(
      (
        await sql(
          `SELECT consecutive_failures, status FROM webhook_endpoints WHERE organization_id = $1`,
          [w.org.organizationId],
        )
      ).rows[0],
    ).toMatchObject({ consecutive_failures: 0, status: 'active' });
  });

  it('stops delivering for a disabled or revoked integration', async () => {
    transport.succeed();
    const w = await world(['customers:read']);
    await endpoint(w);
    await newCustomer(w);
    await fanOutAll(w.org.organizationId);
    const current = (await w.org.owner.get(`/api-integrations/${w.integrationId}`)).body.data;
    const disabled = await w.org.owner.post(`/api-integrations/${w.integrationId}/disable`, {
      version: current.version,
    });
    expect(disabled.status, JSON.stringify(disabled.body)).toBe(200);
    transport.requests.length = 0;
    await drain(w.org.organizationId);
    expect(transport.requests).toHaveLength(0);
    expect((await deliveries(w.org.organizationId))[0]).toMatchObject({
      status: 'cancelled',
      last_error_class: 'scope_revoked',
    });
    await newCustomer(w);
    expect(await fanOutAll(w.org.organizationId)).toBe(0);
  });

  it('follows the organization permission boundary immediately', async () => {
    transport.succeed();
    const w = await world(['customers:read']);
    await endpoint(w);
    await newCustomer(w);
    await fanOutAll(w.org.organizationId);
    const roles = (await w.org.owner.get('/organizations/current/roles')).body.data as {
      id: string;
      name: string;
      description: string;
      isOwner: boolean;
      permissionKeys: string[];
    }[];
    const holders = roles.filter((r) => !r.isOwner && r.permissionKeys.includes('customers.view'));
    for (const r of holders) {
      await w.org.owner.put(`/organizations/current/roles/${r.id}`, {
        name: r.name,
        description: r.description,
        permissionKeys: r.permissionKeys.filter((k) => k !== 'customers.view'),
      });
    }
    transport.requests.length = 0;
    await drain(w.org.organizationId);
    expect(transport.requests).toHaveLength(0);
    expect((await deliveries(w.org.organizationId))[0].status).toBe('cancelled');
  });

  it('cancels pending deliveries of a disabled or deleted endpoint, and sends nothing for it', async () => {
    transport.succeed();
    const w = await world();
    const hook = await endpoint(w);
    const other = await endpoint(w, { name: 'Other' });
    await newCustomer(w);
    await fanOutAll(w.org.organizationId);
    expect(await deliveries(w.org.organizationId)).toHaveLength(2);
    expect(
      (await w.org.owner.post(`/webhooks/endpoints/${hook.id}/disable`, { version: hook.version }))
        .status,
    ).toBe(200);
    expect(
      (await w.org.owner.delete(`/webhooks/endpoints/${other.id}?version=${other.version}`)).status,
    ).toBe(200);
    transport.requests.length = 0;
    await drain(w.org.organizationId);
    expect(transport.requests).toHaveLength(0);
    const states = (await deliveries(w.org.organizationId)).map(
      (d) => `${d.status}:${d.last_error_class}`,
    );
    expect(states).toEqual(['cancelled:endpoint_inactive', 'cancelled:endpoint_inactive']);
    // A disabled endpoint gets no new deliveries.
    await newCustomer(w);
    expect(await fanOutAll(w.org.organizationId)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Ping, disable / re-enable, auto-disable, redelivery, rotation
// ---------------------------------------------------------------------------

describe('endpoint lifecycle', () => {
  it('pings an endpoint, and re-enabling needs a successful ping after the disablement', async () => {
    transport.succeed();
    const w = await world();
    const hook = await endpoint(w);
    transport.requests.length = 0;
    const ping = await w.org.owner.post(`/webhooks/endpoints/${hook.id}/ping`, {});
    expect(ping.status, JSON.stringify(ping.body)).toBe(200);
    expect(ping.body.data).toMatchObject({ success: true, statusCode: 200, errorClass: null });
    const sent = transport.requests[0]!;
    const envelope = bodyOf(sent);
    expect(envelope).toMatchObject({
      type: 'webhook.ping',
      api_version: 'v1',
      organization_id: w.org.organizationId,
      resource: { type: 'webhook_endpoint', id: hook.id },
      data: { object_type: 'webhook_endpoint', object_id: hook.id, url: null },
    });
    expect(sent.headers['intuit-webhook-event']).toBe('webhook.ping');
    expect(sent.headers['intuit-webhook-id']).toBe(ping.body.data.deliveryId);
    expect(verifies(sent, hook.secret)).toBe(true);

    // Disable; enabling needs a NEW successful ping.
    const disabled = await w.org.owner.post(`/webhooks/endpoints/${hook.id}/disable`, {
      version: hook.version,
      reason: 'maintenance',
    });
    expect(disabled.status, JSON.stringify(disabled.body)).toBe(200);
    expect(disabled.body.data).toMatchObject({ status: 'disabled', disabledReason: 'maintenance' });
    expect(
      (
        await w.org.owner.post(`/webhooks/endpoints/${hook.id}/disable`, {
          version: disabled.body.data.version,
        })
      ).status,
    ).toBe(409);
    const early = await w.org.owner.post(`/webhooks/endpoints/${hook.id}/enable`, {
      version: disabled.body.data.version,
    });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('INVALID_STATE_TRANSITION');
    // A failing ping does not unlock it.
    transport.fail(500);
    const failed = await w.org.owner.post(`/webhooks/endpoints/${hook.id}/ping`, {});
    expect(failed.body.data).toMatchObject({
      success: false,
      statusCode: 500,
      errorClass: 'http_status',
    });
    expect(
      (
        await w.org.owner.post(`/webhooks/endpoints/${hook.id}/enable`, {
          version: disabled.body.data.version,
        })
      ).status,
    ).toBe(409);
    // A ping never counts toward automatic disablement.
    expect(
      (await sql(`SELECT consecutive_failures FROM webhook_endpoints WHERE id = $1`, [hook.id]))
        .rows[0].consecutive_failures,
    ).toBe(0);
    transport.succeed();
    expect(
      (await w.org.owner.post(`/webhooks/endpoints/${hook.id}/ping`, {})).body.data.success,
    ).toBe(true);
    const enabled = await w.org.owner.post(`/webhooks/endpoints/${hook.id}/enable`, {
      version: disabled.body.data.version,
    });
    expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
    expect(enabled.body.data).toMatchObject({ status: 'active', disabledAt: null });
    // A changed URL must prove itself again.
    const moved = await w.org.owner.patch(`/webhooks/endpoints/${hook.id}`, {
      version: enabled.body.data.version,
      url: 'https://new.example.com/in',
    });
    expect(moved.body.data.pingVerifiedAt).toBeNull();
    const audit = (
      await sql(
        `SELECT action FROM audit_events WHERE resource_id = $1 ORDER BY occurred_at, action`,
        [hook.id],
      )
    ).rows.map((r) => r.action);
    expect(audit).toEqual(
      expect.arrayContaining([
        'webhook_endpoint.created',
        'webhook_endpoint.pinged',
        'webhook_endpoint.disabled',
        'webhook_endpoint.enabled',
        'webhook_endpoint.updated',
      ]),
    );
  });

  it('auto-disables after 10 consecutive dead deliveries, notifies, and does not backfill', async () => {
    transport.fail(500);
    const w = await world();
    const hook = await endpoint(w);
    const mails = ctx.email.sent.length;
    for (let i = 0; i < AUTO_DISABLE_FAILURES; i += 1) await newCustomer(w);
    await fanOutAll(w.org.organizationId);
    expect(await deliveries(w.org.organizationId)).toHaveLength(AUTO_DISABLE_FAILURES);
    // One failed attempt from the end of each retry cycle.
    await sql(
      `UPDATE webhook_deliveries SET cycle_attempts = 9, attempts_made = 9 WHERE organization_id = $1`,
      [w.org.organizationId],
    );
    await sql(
      `INSERT INTO webhook_delivery_attempts (organization_id, delivery_id, attempt_no, started_at, status_code, error_class)
       SELECT organization_id, id, g, now(), 500, 'http_status' FROM webhook_deliveries, generate_series(1, 9) g WHERE organization_id = $1`,
      [w.org.organizationId],
    );
    await drain(w.org.organizationId);
    const states = (await deliveries(w.org.organizationId)).map((d) => d.status);
    expect(states.filter((s) => s === 'dead').length).toBeGreaterThanOrEqual(
      AUTO_DISABLE_FAILURES - 1,
    );
    const row = (
      await sql(
        `SELECT status, consecutive_failures, disabled_reason FROM webhook_endpoints WHERE id = $1`,
        [hook.id],
      )
    ).rows[0];
    expect(row.status).toBe('auto_disabled');
    expect(row.consecutive_failures).toBeGreaterThanOrEqual(AUTO_DISABLE_FAILURES);
    expect(row.disabled_reason).toMatch(/consecutive failed deliveries/);
    const audit = await sql(
      `SELECT actor_type FROM audit_events WHERE action = 'webhook_endpoint.auto_disabled' AND resource_id = $1`,
      [hook.id],
    );
    expect(audit.rows).toEqual([{ actor_type: 'system' }]);
    expect(ctx.email.sent.length).toBeGreaterThan(mails);
    expect(ctx.email.sent.at(-1)!.template).toBe('webhook-endpoint-auto-disabled');
    // Fan-out stops; events produced meanwhile are not replayed by anything.
    await newCustomer(w);
    expect(await fanOutAll(w.org.organizationId)).toBe(0);
    // Re-enabling takes a ping first.
    const fresh = (await w.org.owner.get(`/webhooks/endpoints/${hook.id}`)).body.data;
    expect(
      (await w.org.owner.post(`/webhooks/endpoints/${hook.id}/enable`, { version: fresh.version }))
        .status,
    ).toBe(409);
    transport.succeed();
    expect(
      (await w.org.owner.post(`/webhooks/endpoints/${hook.id}/ping`, {})).body.data.success,
    ).toBe(true);
    const enabled = await w.org.owner.post(`/webhooks/endpoints/${hook.id}/enable`, {
      version: fresh.version,
    });
    expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
    expect(enabled.body.data.consecutiveFailures).toBe(0);
  });

  it('redelivers a dead delivery as the same delivery and event, audited', async () => {
    transport.fail(500);
    const w = await world();
    const hook = await endpoint(w);
    await newCustomer(w);
    await fanOutAll(w.org.organizationId);
    const [created] = await deliveries(w.org.organizationId);
    await sql(`UPDATE webhook_deliveries SET cycle_attempts = 9, attempts_made = 9 WHERE id = $1`, [
      created.id,
    ]);
    await sql(
      `INSERT INTO webhook_delivery_attempts (organization_id, delivery_id, attempt_no, started_at, status_code, error_class)
       SELECT organization_id, id, g, now(), 500, 'http_status' FROM webhook_deliveries, generate_series(1, 9) g WHERE id = $1`,
      [created.id],
    );
    await drain(w.org.organizationId);
    expect((await deliveries(w.org.organizationId))[0].status).toBe('dead');
    // A pending delivery cannot be redelivered; a dead one can.
    transport.succeed();
    transport.requests.length = 0;
    const redelivered = await w.org.owner.post(`/webhooks/deliveries/${created.id}/redeliver`, {});
    expect(redelivered.status, JSON.stringify(redelivered.body)).toBe(200);
    expect(redelivered.body.data).toMatchObject({
      id: created.id,
      status: 'pending',
      redeliveryCount: 1,
    });
    expect(
      (await w.org.owner.post(`/webhooks/deliveries/${created.id}/redeliver`, {})).status,
    ).toBe(409);
    await drain(w.org.organizationId);
    const [after] = await deliveries(w.org.organizationId);
    expect(after).toMatchObject({
      id: created.id,
      status: 'succeeded',
      event_id: created.event_id,
      attempts_made: 11,
      redelivery_count: 1,
    });
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]!.headers['intuit-webhook-id']).toBe(created.id);
    expect(bodyOf(transport.requests[0]!).id).toBe(created.event_id);
    const detail = (await w.org.owner.get(`/webhooks/deliveries/${created.id}`)).body.data;
    // Attempt numbers continue across the redelivery (9 recorded earlier + the dead one + this).
    expect(detail.attempts).toHaveLength(11);
    expect(detail.attempts.at(-1)).toMatchObject({ attemptNo: 11, statusCode: 200 });
    expect(JSON.stringify(detail)).not.toMatch(/whsec_|v1=/);
    expect(
      (
        await sql(
          `SELECT count(*)::int AS n FROM audit_events WHERE action = 'webhook_delivery.redelivered' AND resource_id = $1`,
          [created.id],
        )
      ).rows[0].n,
    ).toBe(1);
    // An inactive endpoint cannot receive a redelivery.
    const current = (await w.org.owner.get(`/webhooks/endpoints/${hook.id}`)).body.data;
    await w.org.owner.post(`/webhooks/endpoints/${hook.id}/disable`, { version: current.version });
    expect(
      (await w.org.owner.post(`/webhooks/deliveries/${created.id}/redeliver`, {})).status,
    ).toBe(409);
  });

  it('lists delivery history with filters', async () => {
    transport.succeed();
    const w = await world();
    const hook = await endpoint(w);
    for (let i = 0; i < 3; i += 1) await newCustomer(w);
    await fanOutAll(w.org.organizationId);
    await drain(w.org.organizationId);
    const all = await w.org.owner.get(`/webhooks/deliveries?endpointId=${hook.id}&limit=2`);
    expect(all.status, JSON.stringify(all.body)).toBe(200);
    expect(all.body.data).toHaveLength(2);
    expect(all.body.data[0]).toMatchObject({
      endpointId: hook.id,
      status: 'succeeded',
      eventType: 'customer.created',
    });
    expect((await w.org.owner.get('/webhooks/deliveries?status=dead')).body.data).toEqual([]);
    expect((await w.org.owner.get('/webhooks/deliveries?status=succeeded')).body.data).toHaveLength(
      3,
    );
    expect((await w.org.owner.get('/webhooks/deliveries?unknown=1')).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Backpressure, fairness, outbox isolation
// ---------------------------------------------------------------------------

describe('backpressure and outbox isolation', () => {
  it('throttles an endpoint: a delivery waiting for a slot keeps all its attempts', async () => {
    const w = await world();
    const hook = await endpoint(w);
    const claim = (now: Date) =>
      inTransaction(ctx.database.db, { organizationId: w.org.organizationId }, (tx) =>
        claimSendSlot(tx, {
          organizationId: w.org.organizationId,
          endpointId: hook.id,
          concurrency: 1,
          minIntervalMs: 1000,
          leaseMs: 30_000,
          now,
        }),
      );
    const t0 = new Date();
    expect(await claim(t0)).toBe(0);
    const wait = await claim(new Date(t0.getTime() + 10));
    expect(wait).toBeGreaterThan(0);
    // Once the spacing has passed but the lease is still held, the concurrency cap still waits.
    expect(await claim(new Date(t0.getTime() + 2000))).toBeGreaterThan(0);
    // After the lease expires the slot is free again.
    expect(await claim(new Date(t0.getTime() + 31_000))).toBe(0);
  });

  it('defers jobs that cannot get a slot without using up their attempts', async () => {
    const throttled = await createTestContext(
      {
        WEBHOOK_ENCRYPTION_KEYS: KEYS,
        WEBHOOK_ENCRYPTION_ACTIVE_KEY_ID: 'wh1',
        WEBHOOK_ENDPOINT_CONCURRENCY: '1',
        WEBHOOK_ENDPOINT_MIN_INTERVAL_MS: '60000',
      },
      { webhookTransport: transport },
    );
    try {
      transport.succeed();
      const org = await setUpAccountingOrg(throttled);
      const created = await org.owner.post('/api-integrations', {
        name: 'Throttle',
        scopes: ['customers:read'],
      });
      const hook = await org.owner.post('/webhooks/endpoints', {
        name: 'Slow lane',
        url: 'https://hooks.example.com/in',
        integrationId: created.body.data.id,
        eventTypes: ['customer.created'],
      });
      expect(hook.status, JSON.stringify(hook.body)).toBe(201);
      for (let i = 0; i < 3; i += 1) {
        await org.owner.post('/customers', {
          party: { kind: 'organization', displayName: `T${i}` },
        });
      }
      const rows = (
        await sql(
          `SELECT * FROM outbox_events WHERE organization_id = $1 AND event_type LIKE 'public.%'`,
          [org.organizationId],
        )
      ).rows;
      for (const r of rows) {
        await throttled.services.webhookDelivery.fanOut({
          id: r.id,
          eventType: r.event_type,
          organizationId: r.organization_id,
          payload: r.payload,
        } as unknown as OutboxEvent);
      }
      transport.requests.length = 0;
      await isolate(org.organizationId);
      await throttled.worker.runOnce();
      expect(transport.requests).toHaveLength(1); // one send per minute for this endpoint
      const jobs = (
        await sql(
          `SELECT attempts, status, extract(epoch FROM (run_after - now())) AS wait FROM jobs WHERE organization_id = $1 AND type = 'webhook.deliver' ORDER BY created_at`,
          [org.organizationId],
        )
      ).rows;
      const deferred = jobs.filter((j) => j.status === 'queued');
      expect(deferred).toHaveLength(2);
      // The attempt was given back and the wait is short (the lease), not the retry schedule.
      for (const j of deferred) {
        expect(j.attempts).toBe(0);
        expect(Number(j.wait)).toBeLessThan(35);
      }
      const states = (
        await sql(
          `SELECT status, attempts_made FROM webhook_deliveries WHERE organization_id = $1`,
          [org.organizationId],
        )
      ).rows;
      expect(states.filter((s) => s.status === 'pending')).toHaveLength(2);
      expect(states.every((s) => s.attempts_made <= 1)).toBe(true);
    } finally {
      await throttled.close();
    }
  });

  it('dead-letters beyond the per-endpoint queue ceiling as queue_full, counting toward auto-disable', async () => {
    const small = await createTestContext(
      {
        WEBHOOK_ENCRYPTION_KEYS: KEYS,
        WEBHOOK_ENCRYPTION_ACTIVE_KEY_ID: 'wh1',
        WEBHOOK_ENDPOINT_QUEUE_CEILING: '3',
        WEBHOOK_ENDPOINT_MIN_INTERVAL_MS: '0',
      },
      { webhookTransport: transport },
    );
    try {
      const org = await setUpAccountingOrg(small);
      const created = await org.owner.post('/api-integrations', {
        name: 'Ceiling',
        scopes: ['customers:read'],
      });
      const hook = await org.owner.post('/webhooks/endpoints', {
        name: 'Ceiling',
        url: 'https://hooks.example.com/in',
        integrationId: created.body.data.id,
        eventTypes: ['customer.created'],
      });
      expect(hook.status, JSON.stringify(hook.body)).toBe(201);
      for (let i = 0; i < 5; i += 1) {
        await org.owner.post('/customers', {
          party: { kind: 'organization', displayName: `Q${i}` },
        });
      }
      const rows = (
        await sql(
          `SELECT * FROM outbox_events WHERE organization_id = $1 AND event_type LIKE 'public.%' ORDER BY created_at, id`,
          [org.organizationId],
        )
      ).rows;
      for (const r of rows) {
        await small.services.webhookDelivery.fanOut({
          id: r.id,
          eventType: r.event_type,
          organizationId: r.organization_id,
          payload: r.payload,
        } as unknown as OutboxEvent);
      }
      const states = (
        await sql(
          `SELECT status, last_error_class FROM webhook_deliveries WHERE organization_id = $1 ORDER BY created_at, id`,
          [org.organizationId],
        )
      ).rows;
      expect(states.map((s) => s.status)).toEqual([
        'pending',
        'pending',
        'pending',
        'dead',
        'dead',
      ]);
      expect(states.slice(3).every((s) => s.last_error_class === 'queue_full')).toBe(true);
      expect(
        (
          await sql(`SELECT consecutive_failures FROM webhook_endpoints WHERE id = $1`, [
            hook.body.data.id,
          ])
        ).rows[0].consecutive_failures,
      ).toBe(2);
      // Only the accepted deliveries have jobs.
      expect(
        (
          await sql(
            `SELECT count(*)::int AS n FROM jobs WHERE organization_id = $1 AND type = 'webhook.deliver'`,
            [org.organizationId],
          )
        ).rows[0].n,
      ).toBe(3);
    } finally {
      await small.close();
    }
  });

  it('claims outbox events fairly: at most the cap per organization, round-robin', async () => {
    const big = await world();
    const small = await world();
    const type = `test.fairness.t${randomUUID().replaceAll('-', '').slice(0, 8)}`;
    for (const [w, n] of [
      [big, 12],
      [small, 3],
    ] as const) {
      await inTransaction(ctx.database.db, { organizationId: w.org.organizationId }, async (tx) => {
        for (let i = 0; i < n; i += 1) {
          await enqueueOutboxEvent(
            tx,
            {
              eventType: type,
              aggregateType: 'test',
              aggregateId: `${i}`,
              organizationId: w.org.organizationId,
              payload: { n: i },
            },
            new Date(Date.now() - 60_000 + i),
          );
        }
      });
    }
    const seen: string[] = [];
    const dispatcher = new OutboxDispatcher(ctx.database.db, {
      batchSize: 100,
      perOrganizationBatchCap: 5,
      eventTypes: [type],
    });
    dispatcher.subscribe(type, async (event) => void seen.push(event.organizationId!));
    const first = await dispatcher.dispatchBatch();
    expect(first.claimed).toBe(8); // 5 of the large organization + all 3 of the small one
    expect(seen.filter((o) => o === big.org.organizationId)).toHaveLength(5);
    expect(seen.filter((o) => o === small.org.organizationId)).toHaveLength(3);
    // The small organization is fully served in the first batch, not after the large backlog.
    const second = await dispatcher.dispatchBatch();
    expect(second.claimed).toBe(5);
    const third = await dispatcher.dispatchBatch();
    expect(third.claimed).toBe(2);
    expect((await dispatcher.dispatchBatch()).claimed).toBe(0);
  });

  it('subscribes the fan-out to the public event types only, and nothing else sees them', async () => {
    const subscribed: string[] = [];
    const stub = {
      subscribe: (type: string) => void subscribed.push(type),
    } as unknown as OutboxDispatcher;
    ctx.services.webhookDelivery.registerFanOut(stub);
    expect(subscribed.sort()).toEqual(DOMAIN_PUBLIC_EVENT_TYPES.map(publicOutboxType).sort());
    expect(subscribed.every((t) => t.startsWith('public.'))).toBe(true);
    // A dispatcher without the fan-out marks public rows processed and delivers nothing.
    const w = await world();
    await endpoint(w);
    await newCustomer(w);
    const plain = new OutboxDispatcher(ctx.database.db, {
      batchSize: 100,
      eventTypes: ['public.customer.created'],
    });
    await plain.dispatchBatch();
    expect(await deliveries(w.org.organizationId)).toHaveLength(0);
  });

  it('runs end to end through the real dispatcher', async () => {
    transport.succeed();
    const w = await world();
    const hook = await endpoint(w);
    await newCustomer(w);
    const dispatcher = new OutboxDispatcher(ctx.database.db, {
      batchSize: 200,
      perOrganizationBatchCap: 50,
      eventTypes: ['public.customer.created'],
      now: () => ctx.clock.now(),
    });
    ctx.services.webhookDelivery.registerFanOut(dispatcher);
    transport.requests.length = 0;
    await dispatcher.dispatchBatch();
    await drain(w.org.organizationId);
    expect(
      transport.requests.filter((r) => r.url === 'https://hooks.example.com/in').length,
    ).toBeGreaterThanOrEqual(1);
    const mine = await deliveries(w.org.organizationId);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ status: 'succeeded' });
    expect(
      verifies(
        transport.requests.find((r) => r.headers['intuit-webhook-id'] === mine[0].id)!,
        hook.secret,
      ),
    ).toBe(true);
  });
});

describe('database guards', () => {
  it('keeps the webhook tables under row level security and enforces the invariants', async () => {
    transport.succeed();
    const a = await world();
    const b = await world();
    const hook = await endpoint(a);
    await newCustomer(a);
    await fanOutAll(a.org.organizationId);
    await drain(a.org.organizationId);
    // As the application role, organization B's context sees none of A's rows.
    const app = await connectAs('app');
    try {
      await app.query('BEGIN');
      await app.query(`SELECT set_config('app.organization_id', $1, true)`, [b.org.organizationId]);
      for (const table of [
        'webhook_endpoints',
        'webhook_subscriptions',
        'webhook_deliveries',
        'webhook_delivery_attempts',
      ]) {
        expect((await app.query(`SELECT 1 FROM ${table}`)).rowCount, table).toBe(0);
      }
      // ... and cannot write into A's organization.
      await app.query('SAVEPOINT s');
      await expect(
        app.query(
          `INSERT INTO webhook_subscriptions (endpoint_id, organization_id, event_type, created_at)
           VALUES ($1, $2, 'customer.updated', now())`,
          [hook.id, a.org.organizationId],
        ),
      ).rejects.toThrow();
      await app.query('ROLLBACK TO s');
      await app.query('ROLLBACK');
    } finally {
      await app.end();
    }
    const fails = async (statement: string, params: unknown[], pattern: RegExp) => {
      await expect(sql(statement, params)).rejects.toThrow(pattern);
    };
    // The test event cannot be subscribed to; unknown event types are refused by the catalog.
    await fails(
      `INSERT INTO webhook_subscriptions (endpoint_id, organization_id, event_type, created_at) VALUES ($1, $2, 'webhook.ping', now())`,
      [hook.id, a.org.organizationId],
      /webhook_subscriptions_no_ping/,
    );
    await fails(
      `INSERT INTO webhook_subscriptions (endpoint_id, organization_id, event_type, created_at) VALUES ($1, $2, 'journal.posted', now())`,
      [hook.id, a.org.organizationId],
      /violates foreign key/,
    );
    // An endpoint cannot move to another integration or organization; only https URLs are stored.
    await fails(
      `UPDATE webhook_endpoints SET integration_id = $2 WHERE id = $1`,
      [hook.id, b.integrationId],
      /cannot change|foreign key/,
    );
    await fails(
      `UPDATE webhook_endpoints SET url = 'http://x.example.com' WHERE id = $1`,
      [hook.id],
      /webhook_endpoints_url_check/,
    );
    // A delivery is unique per outbox event and endpoint (idempotent fan-out).
    const [delivery] = await deliveries(a.org.organizationId);
    await fails(
      `INSERT INTO webhook_deliveries (organization_id, endpoint_id, event_id, event_type, outbox_event_id, resource_type, resource_id, payload, created_at)
       VALUES ($1, $2, 'evt_dup', 'customer.created', $3, 'customer', 'x', '{}', now())`,
      [a.org.organizationId, hook.id, delivery.outbox_event_id],
      /webhook_deliveries_fanout_idx/,
    );
    // A finished delivery always has a finish time.
    await fails(
      `UPDATE webhook_deliveries SET finished_at = NULL WHERE id = $1`,
      [delivery.id],
      /finished_consistency/,
    );
    // The history is append-only for attempts: there is no UPDATE or DELETE privilege for the app.
    const appRole = await connectAs('app');
    try {
      await appRole.query('BEGIN');
      await appRole.query(`SELECT set_config('app.organization_id', $1, true)`, [
        a.org.organizationId,
      ]);
      await expect(appRole.query(`DELETE FROM webhook_delivery_attempts`)).rejects.toThrow(
        /permission denied/,
      );
      await appRole.query('ROLLBACK');
      await appRole.query('BEGIN');
      await appRole.query(`SELECT set_config('app.organization_id', $1, true)`, [
        a.org.organizationId,
      ]);
      await expect(
        appRole.query(`UPDATE webhook_delivery_attempts SET status_code = 200`),
      ).rejects.toThrow(/permission denied/);
      await appRole.query('ROLLBACK');
    } finally {
      await appRole.end();
    }
    // At most 10 live endpoints, enforced by the database as well.
    for (let i = 0; i < 9; i += 1) await endpoint(a, { name: `Extra ${i}` });
    await fails(
      `INSERT INTO webhook_endpoints (id, organization_id, integration_id, name, url, secret_key_id, secret_iv, secret_tag, secret_ciphertext, created_by_user_id, created_at, updated_at)
       SELECT gen_random_uuid(), organization_id, integration_id, 'overflow', url, secret_key_id, secret_iv, secret_tag, secret_ciphertext, created_by_user_id, now(), now()
         FROM webhook_endpoints WHERE id = $1`,
      [hook.id],
      /at most 10 webhook endpoints/,
    );
  });
});

// ---------------------------------------------------------------------------
// Secret rotation, retention, stale endpoints (these advance the test clock)
// ---------------------------------------------------------------------------

describe('time-dependent behavior', () => {
  it('signs with both secrets during the rotation overlap and only the new one after it', async () => {
    transport.succeed();
    const w = await world();
    const hook = await endpoint(w, { eventTypes: ['customer.created', 'customer.updated'] });
    const rotated = await w.org.owner.post(`/webhooks/endpoints/${hook.id}/rotate-secret`, {
      version: hook.version,
    });
    expect(rotated.status, JSON.stringify(rotated.body)).toBe(200);
    expect(rotated.body.data.secretOverlapUntil).not.toBeNull();
    const newSecret = rotated.body.data.secret as string;
    const customer = await newCustomer(w);
    await fanOutAll(w.org.organizationId);
    transport.requests.length = 0;
    await drain(w.org.organizationId);
    const during = transport.requests[0]!;
    expect(during.headers['intuit-webhook-signature']!.match(/v1=/g)).toHaveLength(2);
    expect(verifies(during, newSecret)).toBe(true);
    expect(verifies(during, hook.secret)).toBe(true); // the previous secret still verifies
    // After the overlap (24 h by default) only the new secret signs.
    const fresh = await world();
    const hook2 = await endpoint(fresh);
    const r2 = await fresh.org.owner.post(`/webhooks/endpoints/${hook2.id}/rotate-secret`, {
      version: hook2.version,
    });
    await newCustomer(fresh);
    await fanOutAll(fresh.org.organizationId);
    ctx.clock.advance(25 * HOUR);
    transport.requests.length = 0;
    await drain(fresh.org.organizationId);
    const after = transport.requests[0]!;
    expect(after.headers['intuit-webhook-signature']!.match(/v1=/g)).toHaveLength(1);
    expect(verifies(after, r2.body.data.secret)).toBe(true);
    expect(verifies(after, hook2.secret)).toBe(false);
    void customer;
  });

  it('purges old finished history and processed public outbox rows, never pending work', async () => {
    transport.succeed();
    const w = await world();
    await endpoint(w);
    await newCustomer(w);
    await newCustomer(w);
    await fanOutAll(w.org.organizationId);
    await drain(w.org.organizationId);
    const [old, recent] = await deliveries(w.org.organizationId);
    const clockNow = ctx.clock.now();
    await sql(`UPDATE webhook_deliveries SET finished_at = $2 WHERE id = $1`, [
      old.id,
      new Date(clockNow.getTime() - 40 * DAY),
    ]);
    await sql(`UPDATE webhook_deliveries SET finished_at = $2 WHERE id = $1`, [
      recent.id,
      new Date(clockNow.getTime() - 5 * DAY),
    ]);
    // A pending delivery is never purged, however old.
    await newCustomer(w);
    await fanOutAll(w.org.organizationId);
    const pendingId = (await deliveries(w.org.organizationId)).find(
      (d) => d.status === 'pending',
    )!.id;
    await sql(`UPDATE webhook_deliveries SET created_at = $2 WHERE id = $1`, [
      pendingId,
      new Date(clockNow.getTime() - 60 * DAY),
    ]);
    // Old processed public outbox rows go; an old non-public one and a recent public one stay.
    const oldPublic = (await publicRows(w.org.organizationId))[0]!;
    await sql(
      `UPDATE outbox_events SET status = 'processed', processed_at = now(), created_at = $2 WHERE id = $1`,
      [oldPublic.id, new Date(clockNow.getTime() - 10 * DAY)],
    );
    const foreign = await sql(
      `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, organization_id, payload, status, available_at, created_at, processed_at)
       VALUES ('user.registered', 'user', 'x', $1, '{}', 'processed', now(), $2, now()) RETURNING id`,
      [w.org.organizationId, new Date(clockNow.getTime() - 10 * DAY)],
    );
    const result = await ctx.services.webhookDelivery.purge();
    expect(result.history).toBeGreaterThanOrEqual(1);
    expect(result.outbox).toBeGreaterThanOrEqual(1);
    const left = (await deliveries(w.org.organizationId)).map((d) => d.id);
    expect(left).not.toContain(old.id);
    expect(left).toContain(recent.id);
    expect(left).toContain(pendingId);
    expect(
      (
        await sql(
          `SELECT count(*)::int AS n FROM webhook_delivery_attempts WHERE delivery_id = $1`,
          [old.id],
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (
        await sql(
          `SELECT count(*)::int AS n FROM webhook_delivery_attempts WHERE delivery_id = $1`,
          [recent.id],
        )
      ).rows[0].n,
    ).toBe(1);
    expect(
      (await sql(`SELECT count(*)::int AS n FROM outbox_events WHERE id = $1`, [oldPublic.id]))
        .rows[0].n,
    ).toBe(0);
    expect(
      (
        await sql(`SELECT count(*)::int AS n FROM outbox_events WHERE id = $1`, [
          foreign.rows[0].id,
        ])
      ).rows[0].n,
    ).toBe(1);
  });

  it('auto-disables an endpoint with failures and no success for 3 days, and dead-letters lost jobs', async () => {
    transport.succeed();
    const w = await world();
    const hook = await endpoint(w);
    const calm = await endpoint(w, { name: 'No failures' });
    const clockNow = ctx.clock.now();
    await sql(
      `UPDATE webhook_endpoints SET consecutive_failures = 2, last_success_at = $2 WHERE id = $1`,
      [hook.id, new Date(clockNow.getTime() - 4 * DAY)],
    );
    // An old endpoint with no failed deliveries is not disabled just for being quiet.
    await sql(
      `UPDATE webhook_endpoints SET created_at = $2, last_success_at = NULL WHERE id = $1`,
      [calm.id, new Date(clockNow.getTime() - 9 * DAY)],
    ).catch(() => undefined);
    const disabled = await ctx.services.webhookDelivery.autoDisableStale();
    expect(disabled).toBeGreaterThanOrEqual(1);
    const rows = (
      await sql(
        `SELECT id, status, disabled_reason FROM webhook_endpoints WHERE organization_id = $1`,
        [w.org.organizationId],
      )
    ).rows;
    expect(rows.find((r) => r.id === hook.id)).toMatchObject({
      status: 'auto_disabled',
      disabled_reason: 'No successful delivery for 3 days',
    });
    expect(rows.find((r) => r.id === calm.id)!.status).toBe('active');

    // A pending delivery whose job ended unsuccessfully can never run: it is dead-lettered.
    const w2 = await world();
    await endpoint(w2);
    await newCustomer(w2);
    await fanOutAll(w2.org.organizationId);
    await sql(
      `UPDATE jobs SET status = 'dead', finished_at = now() WHERE organization_id = $1 AND type = 'webhook.deliver'`,
      [w2.org.organizationId],
    );
    expect(await ctx.services.webhookDelivery.reconcileOrphans()).toBeGreaterThanOrEqual(1);
    expect((await deliveries(w2.org.organizationId))[0]).toMatchObject({
      status: 'dead',
      last_error_class: 'internal',
    });
  });
});
