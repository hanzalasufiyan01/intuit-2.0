import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { inTransaction } from '../src/application/unit-of-work.js';
import {
  claimSendSlot,
  RESOURCE_READ_PERMISSION,
  staleEndpoints,
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
import {
  DOMAIN_PUBLIC_EVENT_TYPES,
  publicOutboxType,
  publishPublicEvent,
  type DomainPublicEventType,
} from '../src/modules/public-events/index.js';
import { buildOpenApiDocument } from '../src/api/public/openapi.js';
import { permissionCatalog } from '../src/application/permission-catalog.js';
import { PUBLIC_API_SCOPES, permissionsForScopes } from '../src/modules/api-integrations/index.js';
import {
  PING_MIN_INTERVAL_MS,
  pingRetryAfterSeconds,
} from '../src/application/webhook-endpoint-service.js';
import {
  AUTO_DISABLE_AFTER_MS,
  AUTO_DISABLE_FAILURES,
} from '../src/application/webhook-delivery-service.js';
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
  // The worker claims a fixed-size batch across organizations. A backlog of due jobs of other
  // types left by earlier files in the shared database can fill the whole drain before this
  // organization's delivery is reached, so they are retired as well.
  await sql(
    `UPDATE jobs SET status = 'failed', finished_at = now(), locked_at = NULL, locked_by = NULL
      WHERE status = 'queued' AND run_after <= now() AND organization_id <> $1`,
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
    // The viewer holds no resource permission at all, only webhooks.view. The endpoint health
    // fields are still returned (ADR 0011 section 25.2, rule 4), with no payload, signature or secret.
    const failedAt = new Date('2026-10-01T10:00:00.000Z');
    const succeededAt = new Date('2026-09-30T08:30:00.000Z');
    await sql(
      `UPDATE webhook_endpoints
          SET consecutive_failures = 4, last_failure_at = $2, last_success_at = $3
        WHERE id = $1`,
      [created.body.data.id, failedAt, succeededAt],
    );
    const listed = await viewer.client.get('/webhooks/endpoints');
    expect(listed.status).toBe(200);
    const detail = await viewer.client.get(`/webhooks/endpoints/${created.body.data.id}`);
    expect(detail.status).toBe(200);
    const health = {
      consecutiveFailures: 4,
      lastFailureAt: failedAt.toISOString(),
      lastSuccessAt: succeededAt.toISOString(),
    };
    const fromList = (listed.body.data as { id: string }[]).find(
      (e) => e.id === created.body.data.id,
    );
    expect(fromList).toMatchObject(health);
    expect(detail.body.data).toMatchObject(health);
    // Exposed fields only: no secret, ciphertext, signature or payload, under any name.
    const forbiddenKey = /secret|cipher|signature|payload(?!Mode)|\biv\b|\btag\b|keyId/i;
    for (const endpoint of [fromList!, detail.body.data]) {
      for (const key of Object.keys(endpoint)) {
        if (key === 'secretOverlapUntil') continue; // a date: whether the previous secret still signs
        expect(key, 'exposed field').not.toMatch(forbiddenKey);
      }
      expect(endpoint.secretOverlapUntil).toBeNull();
    }
    for (const body of [listed.body, detail.body]) {
      const text = JSON.stringify(body);
      expect(text).not.toContain(created.body.data.secret); // the whsec_ value shown once at creation
      expect(text).not.toContain('whsec_');
    }
    // The same response is what a manager gets for these fields: nothing is hidden by role.
    const asAdmin = await admin.client.get(`/webhooks/endpoints/${created.body.data.id}`);
    expect(Object.keys(asAdmin.body.data).sort()).toEqual(Object.keys(detail.body.data).sort());
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
    const audit = await sql(
      `SELECT metadata::text AS m FROM audit_events WHERE organization_id = (SELECT organization_id FROM webhook_endpoints WHERE id = $1::uuid) AND resource_id = $1::text`,
      [created.id],
    );
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
    // Items have no scope (items:read is deferred): not subscribable yet.
    const item = await post({ eventTypes: ['item.created'] });
    expect(item.status).toBe(400);
    expect(issues(item).join(' ')).toMatch(/cannot be subscribed to yet/);
    // The other families have a scope since CR-0011-S6-01, which this integration does not hold.
    for (const type of [
      'credit_note.issued',
      'receipt.recorded',
      'vendor_payment.recorded',
      'expense_claim.posted',
    ]) {
      const res = await post({ eventTypes: [type] });
      expect(res.status, type).toBe(400);
      expect(issues(res).join(' '), type).toMatch(/needs read access that the integration/);
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
          `SELECT count(*)::int AS n FROM audit_events WHERE organization_id = (SELECT organization_id FROM webhook_deliveries WHERE id = $1::uuid) AND action = 'webhook_delivery.dead_lettered' AND resource_id = $1::text`,
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
    // Pings are limited to one per 10 seconds per endpoint; age the earlier ones past the interval.
    const ageThePings = () =>
      sql(
        `UPDATE webhook_deliveries SET created_at = created_at - interval '11 seconds'
          WHERE endpoint_id = $1 AND event_type = 'webhook.ping'`,
        [hook.id],
      );
    await ageThePings();
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
    await ageThePings();
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
        `SELECT action FROM audit_events WHERE organization_id = (SELECT organization_id FROM webhook_endpoints WHERE id = $1::uuid) AND resource_id = $1::text ORDER BY occurred_at, action`,
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
      `SELECT actor_type FROM audit_events WHERE organization_id = (SELECT organization_id FROM webhook_endpoints WHERE id = $1::uuid) AND action = 'webhook_endpoint.auto_disabled' AND resource_id = $1::text`,
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
          `SELECT count(*)::int AS n FROM audit_events WHERE organization_id = (SELECT organization_id FROM webhook_deliveries WHERE id = $1::uuid) AND action = 'webhook_delivery.redelivered' AND resource_id = $1::text`,
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
    // The shared development database keeps every earlier test organization's pending events, and
    // the dispatcher takes the oldest first across organizations: retire the other organizations'
    // pending customer events so this organization's event is inside the batch.
    await sql(
      `UPDATE outbox_events SET status = 'processed', processed_at = now()
        WHERE event_type = 'public.customer.created' AND status = 'pending' AND organization_id <> $1`,
      [w.org.organizationId],
    );
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

// ---------------------------------------------------------------------------
// Delivery-history authorization (CR-0011-S6-01, ADR 0011 sections 11.6 and 25.2)
// ---------------------------------------------------------------------------

describe('delivery-history authorization by event family', () => {
  interface HistoryWorld {
    w: World;
    hook: Awaited<ReturnType<typeof endpoint>>;
    customerIds: string[];
    invoiceIds: string[];
    byType: Record<string, any[]>;
    all: any[];
    clients: Record<
      'owner' | 'admin' | 'member' | 'customerViewer' | 'invoiceManager' | 'hooksOnly',
      any
    >;
    roleIds: Record<string, string>;
  }

  /**
   * One organization with, oldest to newest: 3 customer deliveries, 3 invoice deliveries, 1 ping;
   * all delivered once (so every row has an attempt with a stored excerpt). Plus people of every kind.
   */
  async function historyWorld(): Promise<HistoryWorld> {
    transport.succeed();
    const w = await world();
    const hook = await endpoint(w, { eventTypes: ['customer.created', 'invoice.issued'] });
    const customerIds: string[] = [];
    for (let i = 0; i < 3; i += 1) customerIds.push((await newCustomer(w, `History ${i}`)).id);
    const invoiceIds: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const draft = await w.org.owner.post('/sales/invoices', {
        customerId: customerIds[0],
        invoiceDate: '2026-03-10',
        lines: [{ description: `Line ${i}`, quantity: '1', unitPrice: '10' }],
      });
      expect(draft.status, JSON.stringify(draft.body)).toBe(201);
      const issued = await w.org.owner.post(`/sales/invoices/${draft.body.data.id}/issue`, {
        version: draft.body.data.version,
      });
      expect(issued.status, JSON.stringify(issued.body)).toBe(200);
      invoiceIds.push(draft.body.data.id);
    }
    await fanOutAll(w.org.organizationId);
    await drain(w.org.organizationId);
    const ping = await w.org.owner.post(`/webhooks/endpoints/${hook.id}/ping`, {});
    expect(ping.body.data.success).toBe(true);
    const all = await deliveries(w.org.organizationId);
    expect(all).toHaveLength(7);
    expect(all.every((d) => d.status === 'succeeded')).toBe(true);
    const byType: Record<string, any[]> = {};
    for (const d of all) (byType[d.resource_type] ??= []).push(d);
    expect(byType.customer).toHaveLength(3);
    expect(byType.invoice).toHaveLength(3);
    expect(byType.webhook_endpoint).toHaveLength(1);

    const roleIds: Record<string, string> = {};
    for (const [name, permissionKeys] of [
      ['Customer hooks', ['webhooks.view', 'customers.view']],
      ['Invoice hook manager', ['webhooks.view', 'webhooks.manage', 'invoices.view']],
      ['Hooks only', ['webhooks.view']],
    ] as const) {
      const role = await w.org.owner.post('/organizations/current/roles', {
        name,
        permissionKeys: [...permissionKeys],
      });
      expect(role.status, JSON.stringify(role.body)).toBe(201);
      roleIds[name] = role.body.data.id;
    }
    const clients = {
      owner: w.org.owner,
      admin: (await joinWithRole(ctx, w.org.owner, 'Administrator')).client,
      member: (await joinWithRole(ctx, w.org.owner, 'Member')).client,
      customerViewer: (await joinWithRole(ctx, w.org.owner, 'Customer hooks')).client,
      invoiceManager: (await joinWithRole(ctx, w.org.owner, 'Invoice hook manager')).client,
      hooksOnly: (await joinWithRole(ctx, w.org.owner, 'Hooks only')).client,
    };
    return { w, hook, customerIds, invoiceIds, byType, all, clients, roleIds };
  }

  const list = async (client: any, query = 'limit=200') => {
    const res = await client.get(`/webhooks/deliveries?${query}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res;
  };
  const types = (res: { body: any }) => res.body.data.map((d: any) => d.resource.type as string);
  const notFoundShape = (res: { status: number; body: any }) => {
    const { requestId: _r, ...error } = res.body.error;
    return { status: res.status, error };
  };

  it('filters each person to the families they may read, in the query before the limit', async () => {
    const h = await historyWorld();
    // Owner, Administrator and Member (who holds customers.view and invoices.view) see all 7.
    for (const who of ['owner', 'admin', 'member'] as const) {
      expect((await list(h.clients[who])).body.data, who).toHaveLength(7);
    }
    // Custom roles see only their families, plus the ping.
    expect(types(await list(h.clients.customerViewer)).sort()).toEqual(
      ['customer', 'customer', 'customer', 'webhook_endpoint'].sort(),
    );
    expect(types(await list(h.clients.invoiceManager)).sort()).toEqual(
      ['invoice', 'invoice', 'invoice', 'webhook_endpoint'].sort(),
    );
    expect(types(await list(h.clients.hooksOnly))).toEqual(['webhook_endpoint']);

    // Newest first: ping, invoice x3, customer x3. Filtering happens before the limit, so a
    // customer-only viewer gets a FULL page of its own rows, not a page shortened by hidden ones.
    expect(types(await list(h.clients.customerViewer, 'limit=2'))).toEqual([
      'webhook_endpoint',
      'customer',
    ]);
    expect(types(await list(h.clients.customerViewer, 'limit=4'))).toEqual([
      'webhook_endpoint',
      'customer',
      'customer',
      'customer',
    ]);
    // The other filters compose with the family filter.
    expect(
      types(
        await list(h.clients.customerViewer, `endpointId=${h.hook.id}&status=succeeded&limit=3`),
      ),
    ).toEqual(['webhook_endpoint', 'customer', 'customer']);
    expect((await list(h.clients.customerViewer, 'status=dead')).body.data).toEqual([]);
    // The history response has no totals or cursors that could reveal hidden rows.
    for (const who of ['customerViewer', 'hooksOnly'] as const) {
      expect(Object.keys((await list(h.clients[who], 'limit=1')).body)).toEqual(['data']);
    }
  });

  it('leaks no identifier of a hidden family: detail answers exactly like a missing delivery', async () => {
    const h = await historyWorld();
    const viewer = h.clients.customerViewer;
    const text = JSON.stringify((await list(viewer)).body);
    for (const d of h.byType.invoice!) {
      expect(text).not.toContain(d.id);
      expect(text).not.toContain(d.event_id);
      expect(text).not.toContain(d.resource_id);
    }
    for (const id of h.invoiceIds) expect(text).not.toContain(id);
    // Hidden detail is indistinguishable from a nonexistent delivery.
    const hidden = await viewer.get(`/webhooks/deliveries/${h.byType.invoice![0].id}`);
    const missing = await viewer.get(`/webhooks/deliveries/${randomUUID()}`);
    expect(hidden.status).toBe(404);
    expect(notFoundShape(hidden)).toEqual(notFoundShape(missing));
    // Visible detail works, and the ping is visible to a holder of webhooks.view alone.
    expect((await viewer.get(`/webhooks/deliveries/${h.byType.customer![0].id}`)).status).toBe(200);
    const ping = await h.clients.hooksOnly.get(
      `/webhooks/deliveries/${h.byType.webhook_endpoint![0].id}`,
    );
    expect(ping.status).toBe(200);
    for (const d of [...h.byType.customer!, ...h.byType.invoice!]) {
      expect((await h.clients.hooksOnly.get(`/webhooks/deliveries/${d.id}`)).status).toBe(404);
    }
  });

  it('checks webhooks.manage first (403), then hides other families on redelivery (404)', async () => {
    const h = await historyWorld();
    // Without webhooks.manage: 403 for a visible, a hidden and a nonexistent delivery alike.
    for (const who of ['customerViewer', 'hooksOnly', 'member'] as const) {
      for (const id of [h.byType.customer![0].id, h.byType.invoice![0].id, randomUUID()]) {
        const res = await h.clients[who].post(`/webhooks/deliveries/${id}/redeliver`, {});
        expect(res.status, `${who} ${id}`).toBe(403);
        expect(res.body.error.code).toBe('PERMISSION_DENIED');
      }
    }
    // A manager who cannot read customers: the customer delivery answers like a missing one.
    const manager = h.clients.invoiceManager;
    const hidden = await manager.post(
      `/webhooks/deliveries/${h.byType.customer![0].id}/redeliver`,
      {},
    );
    const missing = await manager.post(`/webhooks/deliveries/${randomUUID()}/redeliver`, {});
    expect(hidden.status).toBe(404);
    expect(notFoundShape(hidden)).toEqual(notFoundShape(missing));
    expect((await manager.get(`/webhooks/deliveries/${h.byType.customer![0].id}`)).status).toBe(
      404,
    );
    // Nothing happened to the hidden delivery.
    const untouched = (
      await sql(`SELECT status, redelivery_count FROM webhook_deliveries WHERE id = $1`, [
        h.byType.customer![0].id,
      ])
    ).rows[0];
    expect(untouched).toEqual({ status: 'succeeded', redelivery_count: 0 });
    // Its own family can be redelivered.
    const own = await manager.post(`/webhooks/deliveries/${h.byType.invoice![0].id}/redeliver`, {});
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(own.body.data).toMatchObject({
      id: h.byType.invoice![0].id,
      status: 'pending',
      redeliveryCount: 1,
    });
  });

  it('returns stored response excerpts only to holders of webhooks.manage', async () => {
    const h = await historyWorld();
    const excerptOf = async (client: any, id: string) => {
      const res = await client.get(`/webhooks/deliveries/${id}`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.data.attempts).toHaveLength(1);
      // The other attempt fields stay visible either way.
      expect(res.body.data.attempts[0]).toMatchObject({
        attemptNo: 1,
        statusCode: 200,
        errorClass: null,
      });
      expect(Object.keys(res.body.data.attempts[0])).toContain('responseExcerpt');
      return res.body.data.attempts[0].responseExcerpt as string | null;
    };
    const customer = h.byType.customer![0].id;
    const invoice = h.byType.invoice![0].id;
    const ping = h.byType.webhook_endpoint![0].id;
    // Managers (Owner, Administrator, the custom manager on its own family) see the excerpt.
    expect(await excerptOf(h.clients.owner, customer)).toBe('{"ok":true}');
    expect(await excerptOf(h.clients.admin, invoice)).toBe('{"ok":true}');
    expect(await excerptOf(h.clients.admin, ping)).toBe('{"ok":true}');
    expect(await excerptOf(h.clients.invoiceManager, invoice)).toBe('{"ok":true}');
    expect(await excerptOf(h.clients.invoiceManager, ping)).toBe('{"ok":true}');
    // View-only people get null, whatever family they may read (Member reads every family here).
    expect(await excerptOf(h.clients.member, customer)).toBeNull();
    expect(await excerptOf(h.clients.member, invoice)).toBeNull();
    expect(await excerptOf(h.clients.customerViewer, customer)).toBeNull();
    expect(await excerptOf(h.clients.hooksOnly, ping)).toBeNull();
    // The list carries no excerpt for anyone.
    for (const who of ['owner', 'member', 'customerViewer'] as const) {
      expect(JSON.stringify((await list(h.clients[who])).body)).not.toContain('ok\\":true');
      expect(JSON.stringify((await list(h.clients[who])).body)).not.toMatch(/excerpt/i);
    }
  });

  it('re-evaluates permissions on every request', async () => {
    const h = await historyWorld();
    const viewer = h.clients.customerViewer;
    const customerDelivery = h.byType.customer![0].id;
    expect((await viewer.get(`/webhooks/deliveries/${customerDelivery}`)).status).toBe(200);
    const role = (await h.w.org.owner.get('/organizations/current/roles')).body.data.find(
      (r: any) => r.id === h.roleIds['Customer hooks'],
    );
    const narrowed = await h.w.org.owner.put(`/organizations/current/roles/${role.id}`, {
      name: role.name,
      description: role.description,
      permissionKeys: ['webhooks.view'],
    });
    expect(narrowed.status, JSON.stringify(narrowed.body)).toBe(200);
    expect((await viewer.get(`/webhooks/deliveries/${customerDelivery}`)).status).toBe(404);
    expect(types(await list(viewer))).toEqual(['webhook_endpoint']);
    // Granting webhooks.manage alone reveals excerpts of what is visible, nothing more.
    await h.w.org.owner.put(`/organizations/current/roles/${role.id}`, {
      name: role.name,
      description: role.description,
      permissionKeys: ['webhooks.view', 'webhooks.manage'],
    });
    expect(types(await list(viewer))).toEqual(['webhook_endpoint']);
    const ping = await viewer.get(`/webhooks/deliveries/${h.byType.webhook_endpoint![0].id}`);
    expect(ping.body.data.attempts[0].responseExcerpt).toBe('{"ok":true}');
  });

  it('keeps every organization to its own history', async () => {
    const h = await historyWorld();
    const other = await world();
    const otherAdmin = (await joinWithRole(ctx, other.org.owner, 'Administrator')).client;
    for (const client of [other.org.owner, otherAdmin]) {
      const text = JSON.stringify((await list(client)).body);
      for (const d of h.all) expect(text).not.toContain(d.id);
      for (const d of h.all) {
        expect((await client.get(`/webhooks/deliveries/${d.id}`)).status).toBe(404);
      }
      const res = await client.post(
        `/webhooks/deliveries/${h.byType.customer![0].id}/redeliver`,
        {},
      );
      expect(res.status).toBe(404);
    }
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
// CR-0011-S6-01 Part A: five subscription-only scopes (ADR 0011 sections 25.4 and 25.5)
// ---------------------------------------------------------------------------

describe('subscription scopes for the remaining event families (CR-0011-S6-01, Part A)', () => {
  /** The approved scopes, their existing permission and the event types they make subscribable. */
  const NEW_SCOPES: Record<string, { permission: string; types: string[] }> = {
    'credit_notes:read': { permission: 'credit_notes.view', types: ['credit_note.issued'] },
    'receipts:read': {
      permission: 'receipts.view',
      types: [
        'receipt.recorded',
        'receipt.voided',
        'customer_refund.recorded',
        'customer_refund.voided',
      ],
    },
    'vendor_credits:read': {
      permission: 'vendor_credits.view',
      types: ['vendor_credit.posted', 'vendor_credit.voided'],
    },
    'vendor_payments:read': {
      permission: 'vendor_payments.view',
      types: [
        'vendor_payment.recorded',
        'vendor_payment.voided',
        'vendor_refund.recorded',
        'vendor_refund.voided',
      ],
    },
    'expense_claims:read': {
      permission: 'expense_claims.view',
      types: ['expense_claim.posted', 'expense_claim.voided'],
    },
  };
  const NEW_TYPES = Object.values(NEW_SCOPES).flatMap((s) => s.types);
  const EXISTING_TYPES = [
    'customer.created',
    'customer.updated',
    'customer.archived',
    'vendor.created',
    'vendor.updated',
    'vendor.archived',
    'invoice.issued',
    'invoice.voided',
    'bill.posted',
    'bill.voided',
  ];
  const ITEM_TYPES = ['item.created', 'item.updated', 'item.archived'];
  const ALL_NEW_SCOPES = Object.keys(NEW_SCOPES);
  const issues = (res: { body: any }) =>
    (res.body.error.details.issues as { path: string; message: string }[]).map((i) => i.message);
  const subscribe = (w: World, eventTypes: string[], extra: Record<string, unknown> = {}) =>
    w.org.owner.post('/webhooks/endpoints', {
      name: `H ${randomUUID().slice(0, 6)}`,
      url: 'https://hooks.example.com/in',
      integrationId: w.integrationId,
      eventTypes,
      ...extra,
    });
  /** Puts a public event of `type` into the outbox, as the originating operation would. */
  async function emit(w: World, type: string, resourceId: string = randomUUID()) {
    await inTransaction(ctx.database.db, { organizationId: w.org.organizationId }, (tx) =>
      publishPublicEvent(
        tx,
        {
          type: type as DomainPublicEventType,
          organizationId: w.org.organizationId,
          resourceId,
          version: 1,
        },
        new Date(),
      ),
    );
    return resourceId;
  }

  it('adds exactly the five approved scopes, each mapped to one existing view permission', async () => {
    const names = PUBLIC_API_SCOPES.map((s) => s.scope);
    expect(names).toHaveLength(13);
    expect(names.slice(0, 8)).toEqual([
      'customers:read',
      'customers:write',
      'items:write',
      'vendors:read',
      'invoices:read',
      'invoices:write',
      'bills:read',
      'accounts:read',
    ]);
    expect(names.slice(8)).toEqual(ALL_NEW_SCOPES);
    const keys = permissionCatalog.map((p) => p.key);
    for (const [scope, spec] of Object.entries(NEW_SCOPES)) {
      const entry = PUBLIC_API_SCOPES.find((s) => s.scope === scope)!;
      expect(entry.permissions, scope).toEqual([spec.permission]);
      expect([...permissionsForScopes([scope])], scope).toEqual([spec.permission]);
      expect(entry.write, scope).toBe(false);
      expect(keys, scope).toContain(spec.permission); // an existing key: none was created
      expect(spec.permission, scope).toMatch(/\.view$/);
      expect(entry.description, scope).toMatch(
        /^Subscribe to webhook events about .+\. Grants no Public API read endpoint\.$/,
      );
    }
    // The catalog endpoint shows the same, read-only.
    const w = await world();
    const listed = (await w.org.owner.get('/api-integrations/scopes')).body.data as {
      scope: string;
      description: string;
      write: boolean;
    }[];
    for (const scope of ALL_NEW_SCOPES) {
      expect(
        listed.find((s) => s.scope === scope),
        scope,
      ).toMatchObject({ write: false });
    }
    // Every family keeps its own permission: a scope never widens into another family's.
    expect([...permissionsForScopes(ALL_NEW_SCOPES)].sort()).toEqual(
      Object.values(NEW_SCOPES)
        .map((s) => s.permission)
        .sort(),
    );
    // Nothing but the five was added: no items:read, no payments:read, no dedicated refund scope.
    for (const absent of ['items:read', 'payments:read', 'refunds:read', 'customer_refunds:read']) {
      expect(names, absent).not.toContain(absent);
    }
    const unknown = await w.org.owner.post('/api-integrations', {
      name: 'Items',
      scopes: ['items:read'],
    });
    expect(unknown.status).toBe(400);
  });

  it('lets each scope subscribe to its own event family and to nothing else', async () => {
    const everything = [...EXISTING_TYPES, ...NEW_TYPES, ...ITEM_TYPES];
    const w = await world(['customers:read']);
    for (const [scope, spec] of Object.entries(NEW_SCOPES)) {
      const only: World = { ...w, integrationId: await integration(w.org, [scope]) };
      // Its own family: accepted, all of it.
      const ok = await subscribe(only, spec.types);
      expect(ok.status, `${scope} ${JSON.stringify(ok.body)}`).toBe(201);
      expect([...ok.body.data.eventTypes].sort(), scope).toEqual([...spec.types].sort());
      // Every other type is refused, each with its own message (one request, one issue each).
      const others = everything.filter((t) => !spec.types.includes(t));
      const refused = await subscribe(only, others);
      expect(refused.status, scope).toBe(400);
      const messages = issues(refused);
      expect(messages, scope).toHaveLength(others.length);
      for (const type of others) {
        const expected = ITEM_TYPES.includes(type)
          ? new RegExp(`^${type} cannot be subscribed to yet`)
          : new RegExp(`^${type} needs read access that the integration does not have`);
        expect(
          messages.some((m) => expected.test(m)),
          `${scope} / ${type}`,
        ).toBe(true);
      }
    }
    // With all five plus the existing scopes, 23 of the 26 domain types are subscribable at once.
    const all: World = {
      ...w,
      integrationId: await integration(w.org, [
        'customers:read',
        'vendors:read',
        'invoices:read',
        'bills:read',
        ...ALL_NEW_SCOPES,
      ]),
    };
    const twentyThree = await subscribe(all, [...EXISTING_TYPES, ...NEW_TYPES]);
    expect(twentyThree.status, JSON.stringify(twentyThree.body)).toBe(201);
    expect(twentyThree.body.data.eventTypes).toHaveLength(23);
  });

  it('uses the shared scopes for refunds: customer refunds need receipts:read, vendor refunds vendor_payments:read', async () => {
    const w = await world(['customers:read']);
    const receipts: World = { ...w, integrationId: await integration(w.org, ['receipts:read']) };
    const payments: World = {
      ...w,
      integrationId: await integration(w.org, ['vendor_payments:read']),
    };
    const credit: World = {
      ...w,
      integrationId: await integration(w.org, ['credit_notes:read', 'vendor_credits:read']),
    };
    expect(
      (await subscribe(receipts, ['customer_refund.recorded', 'customer_refund.voided'])).status,
    ).toBe(201);
    expect(
      (await subscribe(payments, ['vendor_refund.recorded', 'vendor_refund.voided'])).status,
    ).toBe(201);
    // Crossed: a vendor refund is not a receipt event and a customer refund is not a vendor payment.
    for (const [from, type] of [
      [receipts, 'vendor_refund.recorded'],
      [receipts, 'vendor_refund.voided'],
      [payments, 'customer_refund.recorded'],
      [payments, 'customer_refund.voided'],
      [credit, 'customer_refund.recorded'],
      [credit, 'vendor_refund.recorded'],
    ] as const) {
      const res = await subscribe(from, [type]);
      expect(res.status, type).toBe(400);
      expect(issues(res).join(' '), type).toMatch(/needs read access/);
    }
    // There is no dedicated refund scope, and the type-to-permission map says the same.
    expect(PUBLIC_API_SCOPES.some((s) => /refund/.test(s.scope))).toBe(false);
    expect(RESOURCE_READ_PERMISSION.customer_refund).toBe('receipts.view');
    expect(RESOURCE_READ_PERMISSION.vendor_refund).toBe('vendor_payments.view');
    expect(RESOURCE_READ_PERMISSION.item).toBeNull();
  });

  it('grants no Public API read access: no endpoint requires the new scopes and a token with all five calls nothing', async () => {
    const document = buildOpenApiDocument() as { paths: Record<string, Record<string, any>> };
    const required = new Set<string>();
    const readPaths: string[] = [];
    for (const [path, operations] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        if (operation?.['x-required-scope']) required.add(operation['x-required-scope']);
        if (method === 'get') readPaths.push(path);
      }
    }
    for (const scope of ALL_NEW_SCOPES) expect(required.has(scope), scope).toBe(false);
    expect(readPaths.length).toBeGreaterThan(0);
    // Every read endpoint answers 403 to a token that holds only the five new scopes.
    const w = await world(ALL_NEW_SCOPES);
    const created = await w.org.owner.post(`/api-integrations/${w.integrationId}/tokens`, {
      name: 'Subscription only',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    for (const path of readPaths) {
      const res = await ctx.app.inject({
        method: 'GET',
        url: `/public/v1${path.replace(/\{[^}]+\}/g, randomUUID())}`,
        headers: { authorization: `Bearer ${created.body.data.token}` },
        remoteAddress: `198.18.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`,
      });
      expect(res.statusCode, path).toBe(403);
      expect(res.json().error, path).toMatchObject({ type: 'permission_error' });
    }
    // No route for the new families exists under /public/v1 at all.
    for (const family of [
      'credit-notes',
      'receipts',
      'refunds',
      'vendor-credits',
      'expense-claims',
    ]) {
      expect(
        Object.keys(document.paths).some((p) => p.includes(family)),
        family,
      ).toBe(false);
    }
  });

  it('delivers the new families thin, with url null, even to a full-mode endpoint', async () => {
    transport.succeed();
    const w = await world(['customers:read', ...ALL_NEW_SCOPES]);
    await endpoint(w, {
      name: 'Full everything',
      url: 'https://full-all.example.com/in',
      payloadMode: 'full',
      eventTypes: NEW_TYPES,
    });
    const resources = new Map<string, string>();
    for (const type of NEW_TYPES) resources.set(type, await emit(w, type));
    transport.requests.length = 0;
    expect(await fanOutAll(w.org.organizationId)).toBe(NEW_TYPES.length);
    await drain(w.org.organizationId);
    const sent = transport.requests.filter((r) => r.url.startsWith('https://full-all'));
    expect(sent).toHaveLength(NEW_TYPES.length);
    for (const request of sent) {
      const envelope = bodyOf(request);
      const resourceType = envelope.type.slice(0, envelope.type.indexOf('.'));
      // The frozen envelope, unchanged; `data` is exactly the thin reference.
      expect(Object.keys(envelope).sort()).toEqual(
        ['api_version', 'data', 'id', 'occurred_at', 'organization_id', 'resource', 'type'].sort(),
      );
      expect(envelope.data).toEqual({
        object_type: resourceType,
        object_id: resources.get(envelope.type),
        url: null,
      });
      expect(envelope.resource).toMatchObject({
        type: resourceType,
        id: resources.get(envelope.type),
      });
      expect(envelope.data).not.toHaveProperty('object');
      expect(request.headers['intuit-webhook-event']).toBe(envelope.type);
    }
    expect(sent.map((r) => bodyOf(r).type).sort()).toEqual([...NEW_TYPES].sort());
  });

  it('keeps the full payload of the families that already had one', async () => {
    transport.succeed();
    const w = await world(['customers:read', ...ALL_NEW_SCOPES]);
    await endpoint(w, {
      name: 'Full mixed',
      url: 'https://full-mixed.example.com/in',
      payloadMode: 'full',
      eventTypes: ['customer.created', 'receipt.recorded'],
    });
    await endpoint(w, {
      name: 'Thin mixed',
      url: 'https://thin-mixed.example.com/in',
      eventTypes: ['customer.created', 'receipt.recorded'],
    });
    const customer = await newCustomer(w, 'Still Full Ltd');
    const receiptId = await emit(w, 'receipt.recorded');
    transport.requests.length = 0;
    await fanOutAll(w.org.organizationId);
    await drain(w.org.organizationId);
    const body = (host: string, type: string) =>
      bodyOf(
        transport.requests.find(
          (r) => r.url.startsWith(host) && r.headers['intuit-webhook-event'] === type,
        )!,
      );
    // Customer, full endpoint: the public object, as before.
    expect(body('https://full-mixed', 'customer.created').data).toMatchObject({
      object_type: 'customer',
      object_id: customer.id,
      url: `/public/v1/customers/${customer.id}`,
      object: { id: customer.id, name: 'Still Full Ltd' },
    });
    // Customer, thin endpoint: no object. Receipt: thin and without a URL on both.
    expect(body('https://thin-mixed', 'customer.created').data).not.toHaveProperty('object');
    for (const host of ['https://full-mixed', 'https://thin-mixed']) {
      expect(body(host, 'receipt.recorded').data).toEqual({
        object_type: 'receipt',
        object_id: receiptId,
        url: null,
      });
    }
  });

  it('keeps the item events unsubscribable, and the test event out of every subscription', async () => {
    const w = await world(['customers:read', ...ALL_NEW_SCOPES]);
    // Items are deferred: not even with every scope that exists.
    for (const type of ITEM_TYPES) {
      const res = await subscribe(w, [type]);
      expect(res.status, type).toBe(400);
      expect(issues(res).join(' '), type).toMatch(/cannot be subscribed to yet/);
    }
    const catalog = (await w.org.owner.get('/webhooks/event-types')).body.data as {
      type: string;
      subscribable: boolean;
      requiredReadPermission: string | null;
    }[];
    expect(catalog).toHaveLength(DOMAIN_PUBLIC_EVENT_TYPES.length);
    expect(catalog.filter((c) => c.subscribable)).toHaveLength(23);
    expect(
      catalog
        .filter((c) => c.subscribable)
        .map((c) => c.type)
        .sort(),
    ).toEqual([...EXISTING_TYPES, ...NEW_TYPES].sort());
    for (const type of ITEM_TYPES) {
      expect(
        catalog.find((c) => c.type === type),
        type,
      ).toMatchObject({
        subscribable: false,
        requiredReadPermission: null,
      });
    }
    // webhook.ping is not in the business catalog and cannot be a subscription.
    expect(catalog.some((c) => c.type === 'webhook.ping')).toBe(false);
    expect(DOMAIN_PUBLIC_EVENT_TYPES as readonly string[]).not.toContain('webhook.ping');
    const ping = await subscribe(w, ['webhook.ping']);
    expect(ping.status).toBe(400);
    expect(issues(ping).join(' ')).toMatch(/webhook\.ping is not an event type/);
    // The deferred item permission was not introduced.
    expect(permissionCatalog.some((p) => p.key === 'catalog.items.view')).toBe(false);
    // An item event reaching the fan-out creates nothing, whatever the scopes.
    await endpoint(w);
    await emit(w, 'item.created');
    expect(await fanOutAll(w.org.organizationId)).toBe(0);
  });

  it('re-checks the scope, the person and the organization for the new families', async () => {
    transport.succeed();
    const a = await world(['customers:read', 'receipts:read', 'expense_claims:read']);
    const b = await world(['customers:read', 'receipts:read']);
    const hookA = await endpoint(a, { eventTypes: ['receipt.recorded', 'expense_claim.posted'] });
    await endpoint(b, { eventTypes: ['receipt.recorded'] });
    // The person must hold the family's view permission, as well as the integration.
    const role = await a.org.owner.post('/organizations/current/roles', {
      name: 'Hooks only',
      permissionKeys: ['webhooks.view', 'webhooks.manage'],
    });
    expect(role.status).toBe(201);
    const hookOnly = await joinWithRole(ctx, a.org.owner, 'Hooks only');
    const denied = await hookOnly.client.post('/webhooks/endpoints', {
      name: 'Denied',
      url: 'https://hooks.example.com/in',
      integrationId: a.integrationId,
      eventTypes: ['receipt.recorded'],
    });
    expect(denied.status).toBe(400);
    expect(issues(denied).join(' ')).toMatch(/do not have access/);
    // Tenant isolation: an event of organization A reaches only A's endpoint.
    await emit(a, 'receipt.recorded');
    expect(await fanOutAll(a.org.organizationId)).toBe(1);
    expect(await deliveries(b.org.organizationId)).toHaveLength(0);
    // Removing a scope removes the right to receive: the next event creates no delivery.
    const current = await a.org.owner.get(`/api-integrations/${a.integrationId}`);
    const narrowed = await a.org.owner.patch(`/api-integrations/${a.integrationId}`, {
      version: current.body.data.version,
      scopes: ['customers:read', 'receipts:read'],
    });
    expect(narrowed.status, JSON.stringify(narrowed.body)).toBe(200);
    await emit(a, 'expense_claim.posted');
    expect(await fanOutAll(a.org.organizationId)).toBe(0);
    await emit(a, 'receipt.recorded');
    expect(await fanOutAll(a.org.organizationId)).toBe(1);
    // The endpoint keeps its stored subscription; the check is made per event.
    expect(
      (await a.org.owner.get(`/webhooks/endpoints/${hookA.id}`)).body.data.eventTypes.sort(),
    ).toEqual(['expense_claim.posted', 'receipt.recorded']);
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
    // Both endpoints were enabled (created) now; let 4 days pass with no successful delivery.
    // (CR-0011-S6-01: the window starts at the later of the last success and the last enablement.)
    const created = ctx.clock.now();
    ctx.clock.advance(4 * DAY);
    await sql(
      `UPDATE webhook_endpoints SET consecutive_failures = 2, last_success_at = $2 WHERE id = $1`,
      [hook.id, created],
    );
    // An old endpoint with no failed deliveries is not disabled just for being quiet.
    await sql(`UPDATE webhook_endpoints SET last_success_at = NULL WHERE id = $1`, [calm.id]);
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

// ---------------------------------------------------------------------------
// The no-success window (CR-0011-S6-01, migration 0059). Kept last: these advance the test clock.
// ---------------------------------------------------------------------------

describe('the no-success window restarts on re-enable (migration 0059)', () => {
  const endpointRow = async (id: string) =>
    (
      await sql(
        `SELECT status, consecutive_failures, created_at, enabled_at, last_success_at, disabled_reason
           FROM webhook_endpoints WHERE id = $1`,
        [id],
      )
    ).rows[0];

  /** One delivery of the endpoint dead-lettered through the real worker (one failed attempt left). */
  async function oneDeadLetter(w: World) {
    await newCustomer(w);
    await fanOutAll(w.org.organizationId);
    await sql(
      `UPDATE webhook_deliveries SET cycle_attempts = 9, attempts_made = 9
        WHERE organization_id = $1 AND status = 'pending'`,
      [w.org.organizationId],
    );
    await sql(
      `INSERT INTO webhook_delivery_attempts (organization_id, delivery_id, attempt_no, started_at, status_code, error_class)
       SELECT organization_id, id, g, now(), 500, 'http_status'
         FROM webhook_deliveries, generate_series(1, 9) g
        WHERE organization_id = $1 AND status = 'pending'`,
      [w.org.organizationId],
    );
    transport.fail(500);
    await drain(w.org.organizationId);
    transport.succeed();
  }

  it('migration 0059 backfills every existing endpoint from created_at and keeps the guards', async () => {
    transport.succeed();
    const w = await world();
    const active = await endpoint(w, { name: 'Active' });
    const disabled = await endpoint(w, { name: 'Disabled' });
    const deleted = await endpoint(w, { name: 'Deleted' });
    const reenabled = await endpoint(w, { name: 'Re-enabled' });
    expect(
      (
        await w.org.owner.post(`/webhooks/endpoints/${disabled.id}/disable`, {
          version: disabled.version,
        })
      ).status,
    ).toBe(200);
    expect(
      (await w.org.owner.delete(`/webhooks/endpoints/${deleted.id}?version=${deleted.version}`))
        .status,
    ).toBe(200);
    const off = await w.org.owner.post(`/webhooks/endpoints/${reenabled.id}/disable`, {
      version: reenabled.version,
    });
    expect(
      (await w.org.owner.post(`/webhooks/endpoints/${reenabled.id}/ping`, {})).body.data.success,
    ).toBe(true);
    ctx.clock.advance(MINUTE);
    const on = await w.org.owner.post(`/webhooks/endpoints/${reenabled.id}/enable`, {
      version: off.body.data.version,
    });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    const reenabledBefore = await endpointRow(reenabled.id);
    expect(reenabledBefore.enabled_at.getTime()).toBeGreaterThan(
      reenabledBefore.created_at.getTime(),
    );
    const ours = [active.id, disabled.id, deleted.id, reenabled.id];

    // Replay the migration on the real table, inside a transaction that is rolled back.
    const migration = readFileSync(
      new URL('../src/database/migrations/0059_webhook_enabled_at.sql', import.meta.url),
      'utf8',
    );
    await sql('BEGIN');
    try {
      await sql('ALTER TABLE webhook_endpoints DROP COLUMN enabled_at');
      await sql(migration);
      const all = await sql(
        `SELECT count(*)::int AS n,
                count(*) FILTER (WHERE enabled_at IS DISTINCT FROM created_at)::int AS differing,
                count(*) FILTER (WHERE deleted_at IS NOT NULL)::int AS deleted
           FROM webhook_endpoints`,
      );
      // Every row, including deleted ones, was backfilled with its creation time.
      expect(all.rows[0].n).toBeGreaterThanOrEqual(4);
      expect(all.rows[0].deleted).toBeGreaterThanOrEqual(1);
      expect(all.rows[0].differing).toBe(0);
      const mine = await sql(
        `SELECT id, enabled_at = created_at AS same FROM webhook_endpoints WHERE id = ANY($1::uuid[])`,
        [ours],
      );
      expect(mine.rows).toHaveLength(4);
      expect(mine.rows.every((r) => r.same === true)).toBe(true);
      // NOT NULL, no default, the ordering check, and the 0058 guard back in force.
      const column = (
        await sql(
          `SELECT is_nullable, column_default, data_type FROM information_schema.columns
            WHERE table_name = 'webhook_endpoints' AND column_name = 'enabled_at'`,
        )
      ).rows[0];
      expect(column).toEqual({
        is_nullable: 'NO',
        column_default: null,
        data_type: 'timestamp with time zone',
      });
      expect(
        (
          await sql(
            `SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'webhook_endpoints_enabled_after_created'`,
          )
        ).rows[0].n,
      ).toBe(1);
      expect(
        (await sql(`SELECT tgenabled FROM pg_trigger WHERE tgname = 'webhook_endpoints_guard'`))
          .rows[0].tgenabled,
      ).toBe('O');
      await sql('SAVEPOINT guard');
      await expect(
        sql(`UPDATE webhook_endpoints SET name = 'x' WHERE id = $1`, [deleted.id]),
      ).rejects.toThrow(/is deleted/);
      await sql('ROLLBACK TO SAVEPOINT guard');
    } finally {
      await sql('ROLLBACK');
    }
    // The rollback restored the real values.
    expect((await endpointRow(reenabled.id)).enabled_at.getTime()).toBe(
      reenabledBefore.enabled_at.getTime(),
    );
  });

  it('records the activation time at creation and on every return to active, and rejects invalid rows', async () => {
    transport.succeed();
    const w = await world();
    const before = ctx.clock.now().getTime();
    const hook = await endpoint(w);
    const created = await endpointRow(hook.id);
    expect(created.enabled_at.getTime()).toBe(created.created_at.getTime());
    expect(created.enabled_at.getTime()).toBeGreaterThanOrEqual(before);
    // Disabling does not move it.
    const off = await w.org.owner.post(`/webhooks/endpoints/${hook.id}/disable`, {
      version: hook.version,
    });
    expect((await endpointRow(hook.id)).enabled_at.getTime()).toBe(created.enabled_at.getTime());
    expect(
      (await w.org.owner.post(`/webhooks/endpoints/${hook.id}/ping`, {})).body.data.success,
    ).toBe(true);
    ctx.clock.advance(2 * MINUTE);
    const enabling = ctx.clock.now().getTime();
    const on = await w.org.owner.post(`/webhooks/endpoints/${hook.id}/enable`, {
      version: off.body.data.version,
    });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    const after = await endpointRow(hook.id);
    expect(after.enabled_at.getTime()).toBeGreaterThanOrEqual(enabling);
    expect(after.enabled_at.getTime()).toBeLessThanOrEqual(ctx.clock.now().getTime());
    expect(after.created_at.getTime()).toBe(created.created_at.getTime());
    // An auto-disabled endpoint that returns to active is re-stamped as well.
    await sql(
      `UPDATE webhook_endpoints SET status = 'auto_disabled', disabled_at = $2, disabled_reason = 'test' WHERE id = $1`,
      [hook.id, ctx.clock.now()],
    );
    expect(
      (await w.org.owner.post(`/webhooks/endpoints/${hook.id}/ping`, {})).body.data.success,
    ).toBe(true);
    ctx.clock.advance(MINUTE);
    const current = (await w.org.owner.get(`/webhooks/endpoints/${hook.id}`)).body.data;
    expect(
      (
        await w.org.owner.post(`/webhooks/endpoints/${hook.id}/enable`, {
          version: current.version,
        })
      ).status,
    ).toBe(200);
    expect((await endpointRow(hook.id)).enabled_at.getTime()).toBeGreaterThan(
      after.enabled_at.getTime(),
    );
    // Future rows must carry a valid value: none (no default) or one before creation is refused.
    const insert = (enabledAt: string) =>
      sql(
        `INSERT INTO webhook_endpoints (id, organization_id, integration_id, name, url, secret_key_id, secret_iv,
                                        secret_tag, secret_ciphertext, created_by_user_id, created_at, updated_at ${enabledAt === 'omit' ? '' : ', enabled_at'})
         SELECT gen_random_uuid(), organization_id, integration_id, 'Raw ' || gen_random_uuid(), url, secret_key_id,
                secret_iv, secret_tag, secret_ciphertext, created_by_user_id, now(), now()
                ${enabledAt === 'omit' ? '' : `, ${enabledAt}`}
           FROM webhook_endpoints WHERE id = $1`,
        [hook.id],
      );
    await expect(insert('omit')).rejects.toThrow(
      /enabled_at.*not-null|null value in column "enabled_at"/,
    );
    await expect(insert(`now() - interval '1 day'`)).rejects.toThrow(
      /webhook_endpoints_enabled_after_created/,
    );
  });

  it('a recent re-enable is not disabled by an old success; the window then runs 3 days from it', async () => {
    transport.succeed();
    const w = await world();
    const hook = await endpoint(w);
    // One successful delivery, then 4 quiet days.
    await newCustomer(w);
    await fanOutAll(w.org.organizationId);
    await drain(w.org.organizationId);
    const success = (await endpointRow(hook.id)).last_success_at as Date;
    expect(success).not.toBeNull();
    ctx.clock.advance(4 * DAY);
    expect((await w.org.owner.login(w.org.ownerEmail)).status).toBe(200);
    // With failures and neither a recent success nor a recent enablement, it is disabled.
    await sql(`UPDATE webhook_endpoints SET consecutive_failures = 2 WHERE id = $1`, [hook.id]);
    expect(await ctx.services.webhookDelivery.autoDisableStale()).toBeGreaterThanOrEqual(1);
    expect(await endpointRow(hook.id)).toMatchObject({
      status: 'auto_disabled',
      disabled_reason: 'No successful delivery for 3 days',
    });
    // Fixed, pinged and re-enabled now: last_success_at is still 4 days old.
    expect(
      (await w.org.owner.post(`/webhooks/endpoints/${hook.id}/ping`, {})).body.data.success,
    ).toBe(true);
    const current = (await w.org.owner.get(`/webhooks/endpoints/${hook.id}`)).body.data;
    const enabled = await w.org.owner.post(`/webhooks/endpoints/${hook.id}/enable`, {
      version: current.version,
    });
    expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
    // The first dead letter after the re-enable does NOT disable it (the defect fixed by 0059).
    await oneDeadLetter(w);
    const afterFailure = await endpointRow(hook.id);
    expect(afterFailure.last_success_at.getTime()).toBe(success.getTime());
    expect(afterFailure).toMatchObject({ status: 'active', consecutive_failures: 1 });
    expect(
      (await deliveries(w.org.organizationId)).filter((d) => d.status === 'dead'),
    ).toHaveLength(1);
    // Two days later it is still inside the window.
    ctx.clock.advance(2 * DAY);
    await ctx.services.webhookDelivery.autoDisableStale();
    expect((await endpointRow(hook.id)).status).toBe('active');
    // Three days and a minute after the re-enable, with no success, it is disabled.
    ctx.clock.advance(DAY + MINUTE);
    await ctx.services.webhookDelivery.autoDisableStale();
    expect(await endpointRow(hook.id)).toMatchObject({
      status: 'auto_disabled',
      disabled_reason: 'No successful delivery for 3 days',
    });
  });

  it('the failure path and the stale query apply the same baseline', async () => {
    transport.succeed();
    const w = await world();
    const ids: Record<string, string> = {};
    for (const name of ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7'])
      ids[name] = (await endpoint(w, { name })).id;
    // All seven were created (and enabled) now; ten days pass.
    ctx.clock.advance(10 * DAY);
    const now = ctx.clock.now().getTime();
    const ago = (ms: number) => new Date(now - ms);
    const cases: { name: string; last: Date | null; enabled?: Date; stale: boolean }[] = [
      { name: 'M1', last: null, stale: true }, // enabled 10 days ago, never succeeded
      { name: 'M2', last: ago(12 * HOUR), stale: false }, // recent success
      { name: 'M3', last: ago(9 * DAY), enabled: ago(12 * HOUR), stale: false }, // recent re-enable
      { name: 'M4', last: ago(9 * DAY), enabled: ago(8 * DAY), stale: true }, // both old
      { name: 'M5', last: null, enabled: ago(2 * DAY), stale: false }, // re-enabled, never succeeded
      { name: 'M6', last: null, enabled: ago(3 * DAY - MINUTE), stale: false }, // just inside
      { name: 'M7', last: ago(3 * DAY + MINUTE), stale: true }, // just outside
    ];
    for (const c of cases) {
      await sql(
        `UPDATE webhook_endpoints SET consecutive_failures = 1, last_success_at = $2,
                enabled_at = coalesce($3, enabled_at) WHERE id = $1`,
        [ids[c.name], c.last, c.enabled ?? null],
      );
    }
    const expected = cases
      .filter((c) => c.stale)
      .map((c) => ids[c.name])
      .sort();
    // Database path: the stale-endpoint query.
    const fromQuery = (
      await inTransaction(ctx.database.db, { organizationId: w.org.organizationId }, (tx) =>
        staleEndpoints(tx, w.org.organizationId, new Date(now - AUTO_DISABLE_AFTER_MS)),
      )
    )
      .map((e) => e.id)
      .sort();
    expect(fromQuery).toEqual(expected);
    // Application path: the failure bookkeeping (one more failure, far below the count of 10).
    const fromFailure: string[] = [];
    for (const c of cases) {
      const disabled = await inTransaction(
        ctx.database.db,
        { organizationId: w.org.organizationId },
        (tx) =>
          ctx.services.webhookDelivery.registerFailure(
            tx,
            w.org.organizationId,
            ids[c.name]!,
            null,
          ),
      );
      if (disabled) fromFailure.push(ids[c.name]!);
    }
    expect(fromFailure.sort()).toEqual(expected);
    // And every disabled endpoint names the 3-day rule, not the count rule.
    const reasons = await sql(
      `SELECT DISTINCT disabled_reason FROM webhook_endpoints WHERE id = ANY($1::uuid[])`,
      [expected],
    );
    expect(reasons.rows.map((r) => r.disabled_reason)).toEqual([
      'No successful delivery for 3 days',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Ping throttle and automatic-disablement notifications (CR-0011-S6-01, ADR 0011 section 25.3).
// Last in the file: some tests advance the test clock.
// ---------------------------------------------------------------------------

describe('ping throttle: one ping per endpoint per 10 seconds', () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const pingRows = async (id: string) =>
    (
      await sql(
        `SELECT id, status, created_at FROM webhook_deliveries
          WHERE endpoint_id = $1 AND event_type = 'webhook.ping' ORDER BY created_at`,
        [id],
      )
    ).rows;
  const pingAudits = async (id: string) =>
    (
      await sql(
        `SELECT metadata FROM audit_events WHERE organization_id = (SELECT organization_id FROM webhook_endpoints WHERE id = $1::uuid) AND action = 'webhook_endpoint.pinged' AND resource_id = $1::text`,
        [id],
      )
    ).rows;
  const ping = (client: any, id: string) => client.post(`/webhooks/endpoints/${id}/ping`, {});
  /** Dates the endpoint's (single) latest ping delivery `ageMs` before the test clock's now. */
  const setPingAge = (id: string, ageMs: number) =>
    sql(
      `UPDATE webhook_deliveries SET created_at = $2
        WHERE endpoint_id = $1 AND event_type = 'webhook.ping'`,
      [id, new Date(ctx.clock.now().getTime() - ageMs)],
    );
  const expectThrottled = (res: any, seconds: number) => {
    expect(res.status, JSON.stringify(res.body)).toBe(429);
    expect(res.body.error.code).toBe('TOO_MANY_ATTEMPTS');
    expect(res.body.error.message).toBe('Too many attempts. Please wait and try again.');
    expect(res.headers['retry-after']).toBe(String(seconds));
  };

  it('computes the wait: rounded up whole seconds, clamped to 1..10, allowed at exactly 10 s', () => {
    expect(PING_MIN_INTERVAL_MS).toBe(10_000);
    const cases: [number, number | null][] = [
      [-60_000, 10], // dated in the future (clock skew): the longest wait
      [-1, 10],
      [0, 10],
      [1, 10],
      [999, 10],
      [1_000, 9],
      [1_001, 9],
      [5_000, 5],
      [8_999, 2],
      [9_000, 1],
      [9_001, 1],
      [9_999, 1],
      [10_000, null], // exactly the interval: allowed
      [10_001, null],
      [3_600_000, null],
    ];
    for (const [elapsed, wait] of cases) {
      expect(pingRetryAfterSeconds(elapsed), `elapsed ${elapsed} ms`).toBe(wait);
    }
  });

  it('refuses a second ping inside the interval with the exact 429 contract, then allows it again', async () => {
    transport.succeed();
    const w = await world();
    const hook = await endpoint(w);
    const first = await ping(w.org.owner, hook.id);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.data.success).toBe(true);
    // Straight away: refused, 10 seconds to wait.
    expectThrottled(await ping(w.org.owner, hook.id), 10);
    // Boundaries through the real endpoint (the latest ping is dated to the stated age; the request
    // itself takes some milliseconds, so the ages keep a margin from the second boundaries).
    for (const [ageMs, seconds] of [
      [0, 10],
      [1_000, 9],
      [5_000, 5],
      [9_000, 1],
    ] as const) {
      await setPingAge(hook.id, ageMs);
      expectThrottled(await ping(w.org.owner, hook.id), seconds);
    }
    // Past the interval it is allowed, and that ping starts a new interval.
    await setPingAge(hook.id, PING_MIN_INTERVAL_MS + 500);
    expect((await ping(w.org.owner, hook.id)).status).toBe(200);
    expectThrottled(await ping(w.org.owner, hook.id), 10);
    expect(await pingRows(hook.id)).toHaveLength(2);
  });

  it('counts failed pings, and everyone and every endpoint status share the interval', async () => {
    const w = await world();
    const admin = (await joinWithRole(ctx, w.org.owner, 'Administrator')).client;
    const other = (await joinWithRole(ctx, w.org.owner, 'Administrator')).client;
    const hook = await endpoint(w);
    const second = await endpoint(w, { name: 'Second endpoint' });
    // A failed ping consumes the interval too.
    transport.fail(503);
    const failed = await ping(admin, hook.id);
    expect(failed.status).toBe(200);
    expect(failed.body.data).toMatchObject({ success: false, statusCode: 503 });
    transport.succeed();
    // ... for the same person, another administrator and the Owner.
    for (const client of [admin, other, w.org.owner])
      expectThrottled(await ping(client, hook.id), 10);
    // The interval belongs to the endpoint: another endpoint of the organization is not affected.
    expect((await ping(other, second.id)).status).toBe(200);
    // It applies in every status: a disabled and an auto-disabled endpoint are throttled too.
    const off = await w.org.owner.post(`/webhooks/endpoints/${hook.id}/disable`, {
      version: hook.version,
    });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    await setPingAge(hook.id, 10_500);
    expect((await ping(other, hook.id)).status).toBe(200); // disabled endpoints can be pinged
    expectThrottled(await ping(admin, hook.id), 10);
    await sql(
      `UPDATE webhook_endpoints SET status = 'auto_disabled', disabled_reason = 'test' WHERE id = $1`,
      [hook.id],
    );
    await sql(
      `UPDATE webhook_deliveries SET created_at = $2 WHERE endpoint_id = $1 AND event_type = 'webhook.ping'`,
      [hook.id, new Date(ctx.clock.now().getTime() - 10_500)],
    );
    expect((await ping(admin, hook.id)).status).toBe(200);
    expectThrottled(await ping(w.org.owner, hook.id), 10);
    // A throttled request in another organization's name changes nothing here.
    const foreign = await world();
    expect((await ping(foreign.org.owner, hook.id)).status).toBe(404);
    expect(await pingRows(hook.id)).toHaveLength(3);
  });

  it('lets only one of many concurrent pings through, and serializes on the endpoint row lock', async () => {
    transport.succeed();
    const w = await world();
    const admins = [
      (await joinWithRole(ctx, w.org.owner, 'Administrator')).client,
      (await joinWithRole(ctx, w.org.owner, 'Administrator')).client,
    ];
    const clients = [w.org.owner, ...admins];
    const hook = await endpoint(w);
    // Six requests at once, from three people.
    const responses = await Promise.all(
      Array.from({ length: 6 }, (_, i) => ping(clients[i % clients.length], hook.id)),
    );
    const statuses = responses.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 429, 429, 429, 429, 429]);
    for (const r of responses.filter((x) => x.status === 429)) expectThrottled(r, 10);
    expect(await pingRows(hook.id)).toHaveLength(1);
    expect(await pingAudits(hook.id)).toHaveLength(1);

    // The lock itself: while another connection holds the endpoint row, a ping WAITS for it (it
    // does not read stale state and pass), and it proceeds once the lock is released.
    const second = await endpoint(w, { name: 'Locked endpoint' });
    const locker = await connectAs('owner');
    try {
      await locker.query('BEGIN');
      await locker.query(`SELECT id FROM webhook_endpoints WHERE id = $1 FOR UPDATE`, [second.id]);
      let settled = false;
      const waiting = ping(w.org.owner, second.id).then((res: any) => {
        settled = true;
        return res;
      });
      await sleep(700);
      expect(settled, 'the ping must wait for the row lock').toBe(false);
      expect(await pingRows(second.id)).toHaveLength(0);
      await locker.query('COMMIT');
      const released = await waiting;
      expect(released.status, JSON.stringify(released.body)).toBe(200);
      expect(await pingRows(second.id)).toHaveLength(1);
    } finally {
      await locker.end();
    }

    // The lock is held only for the short first transaction, never during the network request:
    // while one ping is on the wire, a concurrent ping is refused at once instead of waiting.
    const third = await endpoint(w, { name: 'Slow endpoint' });
    transport.duringSend = async () => {
      await sleep(1500);
    };
    try {
      const slow = ping(w.org.owner, third.id);
      await sleep(300);
      const t0 = Date.now();
      const refused = await ping(admins[0], third.id);
      expect(Date.now() - t0).toBeLessThan(1000);
      expectThrottled(refused, 10);
      expect((await slow).status).toBe(200);
    } finally {
      transport.duringSend = null;
    }
    expect(await pingRows(third.id)).toHaveLength(1);
    expect(await pingAudits(third.id)).toHaveLength(1);
  });

  it('writes neither a delivery nor an audit event for a refused ping; a sent ping is audited and never counts as a failure', async () => {
    const w = await world();
    const hook = await endpoint(w);
    await sql(`UPDATE webhook_endpoints SET consecutive_failures = 3 WHERE id = $1`, [hook.id]);
    const counters = async () =>
      (
        await sql(
          `SELECT consecutive_failures, last_failure_at, last_success_at, version, status
             FROM webhook_endpoints WHERE id = $1`,
          [hook.id],
        )
      ).rows[0];
    const before = await counters();
    // A successful ping: audited once with its delivery, success flag and status code.
    transport.succeed();
    const ok = await ping(w.org.owner, hook.id);
    expect(ok.status).toBe(200);
    const audits = await pingAudits(hook.id);
    expect(audits).toHaveLength(1);
    expect(audits[0].metadata).toMatchObject({
      deliveryId: ok.body.data.deliveryId,
      success: true,
      statusCode: 200,
    });
    expect((await counters()).consecutive_failures).toBe(3);
    // Refused pings leave no trace: the same number of deliveries, audit events and outbox rows.
    const trace = async () => ({
      deliveries: (await deliveries(w.org.organizationId)).length,
      audits: (
        await sql(`SELECT count(*)::int AS n FROM audit_events WHERE organization_id = $1`, [
          w.org.organizationId,
        ])
      ).rows[0].n,
    });
    const traced = await trace();
    for (let i = 0; i < 3; i += 1) expectThrottled(await ping(w.org.owner, hook.id), 10);
    expect(await trace()).toEqual(traced);
    // A failed ping is audited as failed and does not touch the failure counters either.
    await setPingAge(hook.id, 10_500);
    transport.fail(500);
    const bad = await ping(w.org.owner, hook.id);
    transport.succeed();
    expect(bad.body.data).toMatchObject({ success: false, errorClass: 'http_status' });
    expect(await pingAudits(hook.id)).toHaveLength(2);
    const after = await counters();
    expect(after.consecutive_failures).toBe(3);
    expect(after.last_failure_at).toEqual(before.last_failure_at);
    expect(after.status).toBe('active');
    expect(after.version).toBe(before.version); // bookkeeping only, not a user change
  });

  it('keeps authorization as it was: webhooks.manage only, checked before the throttle, no re-authentication', async () => {
    transport.succeed();
    const w = await world();
    const hook = await endpoint(w);
    const member = (await joinWithRole(ctx, w.org.owner, 'Member')).client; // view only
    const role = await w.org.owner.post('/organizations/current/roles', {
      name: 'Pinger',
      permissionKeys: ['webhooks.manage'],
    });
    expect(role.status).toBe(201);
    const pinger = (await joinWithRole(ctx, w.org.owner, 'Pinger')).client;
    const foreign = await world();
    expect((await ping(w.org.owner, hook.id)).status).toBe(200); // now inside the interval
    // Without webhooks.manage: 403 whether the endpoint is throttled, missing or foreign.
    for (const id of [hook.id, randomUUID()]) {
      const res = await ping(member, id);
      expect(res.status, id).toBe(403);
      expect(res.body.error.code).toBe('PERMISSION_DENIED');
    }
    // A manager gets 404 for a missing endpoint (not 429) and cannot reach another organization's.
    expect((await ping(pinger, randomUUID())).status).toBe(404);
    expect((await ping(foreign.org.owner, hook.id)).status).toBe(404);
    // webhooks.manage alone is enough: no view permission, no password confirmation, no second factor.
    expectThrottled(await ping(pinger, hook.id), 10);
    await setPingAge(hook.id, 10_500);
    expect((await ping(pinger, hook.id)).status).toBe(200);
    // A session older than the re-authentication window can still ping, but not change the endpoint.
    await setPingAge(hook.id, 10_500);
    ctx.clock.advance(16 * MINUTE);
    await w.org.owner.get('/auth/session');
    expect((await ping(w.org.owner, hook.id)).status).toBe(200);
    const sensitive = await w.org.owner.post(`/webhooks/endpoints/${hook.id}/disable`, {
      version: hook.version,
    });
    expect(sensitive.status).toBe(403);
    expect(sensitive.body.error.code).toBe('REAUTHENTICATION_REQUIRED');
  });

  it('characterizes a latest ping dated in the future (clock skew): always the longest wait, released only once the local clock passes it by 10 s', async () => {
    // Pure function, current behavior. Elapsed is "now minus the latest ping's stored time", so a
    // ping stored by an instance whose clock is AHEAD gives a negative elapsed time here.
    for (const skewMs of [1, 999, 1_000, 9_000, 10_000, 11_000, 60_000, 3_600_000, 86_400_000]) {
      expect(pingRetryAfterSeconds(-skewMs), `ahead by ${skewMs} ms`).toBe(10);
    }
    // Never zero, never above 10, never "allowed" while the stored time is still in the future.
    for (let elapsed = -120_000; elapsed < 0; elapsed += 7_919) {
      const wait = pingRetryAfterSeconds(elapsed);
      expect(wait, `elapsed ${elapsed}`).not.toBeNull();
      expect(wait!).toBeGreaterThanOrEqual(1);
      expect(wait!).toBeLessThanOrEqual(10);
    }
    // The throttle lifts exactly when the local clock is 10 s past the stored time, so the real
    // refusal lasts skew + 10 s while Retry-After says 10 (a limitation of the header, not a loop).
    for (const skewMs of [0, 5_000, 60_000]) {
      // The stored time is `skewMs` ahead of the local clock now: elapsed starts at -skewMs and
      // grows with real time. Find the first moment (0.5 s steps) at which a ping is allowed.
      let allowedAtElapsed: number | null = null;
      for (let elapsed = -skewMs; elapsed <= 20_000; elapsed += 500) {
        if (pingRetryAfterSeconds(elapsed) === null) {
          allowedAtElapsed = elapsed;
          break;
        }
      }
      expect(allowedAtElapsed, `skew ${skewMs}`).toBe(PING_MIN_INTERVAL_MS);
      // Real time that passed meanwhile: from elapsed -skew to +10 s.
      expect(allowedAtElapsed! + skewMs, `refused for, skew ${skewMs}`).toBe(
        skewMs + PING_MIN_INTERVAL_MS,
      );
    }
    // Through the real endpoint: a latest ping stored 60 s ahead is refused with Retry-After 10,
    // and it stays refused until the clock catches up. No row or audit event is created.
    transport.succeed();
    const w = await world();
    const hook = await endpoint(w);
    expect((await ping(w.org.owner, hook.id)).status).toBe(200);
    await setPingAge(hook.id, -60_000);
    const before = {
      rows: (await pingRows(hook.id)).length,
      audits: (await pingAudits(hook.id)).length,
    };
    expectThrottled(await ping(w.org.owner, hook.id), 10);
    expectThrottled(await ping(w.org.owner, hook.id), 10);
    expect({
      rows: (await pingRows(hook.id)).length,
      audits: (await pingAudits(hook.id)).length,
    }).toEqual(before);
    await setPingAge(hook.id, PING_MIN_INTERVAL_MS + 500);
    expect((await ping(w.org.owner, hook.id)).status).toBe(200);
  });

  it('leaves a pending ping and consumes the interval when the request fails between the two transactions', async () => {
    transport.succeed();
    const w = await world();
    const hook = await endpoint(w);
    // The failure boundary: the first transaction (delivery row) has committed, the request was
    // attempted, and the second transaction (attempt, outcome, audit) never runs. Simulated by
    // making the real `attempt` step throw; production code is unchanged.
    const failing = vi
      .spyOn(ctx.services.webhookDelivery, 'attempt')
      .mockRejectedValueOnce(new Error('simulated crash between the transactions'));
    let crashed;
    try {
      crashed = await ping(w.org.owner, hook.id);
    } finally {
      failing.mockRestore();
    }
    expect(crashed.status).toBe(500);
    const rows = await pingRows(hook.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('pending');
    const attempts = await sql(
      `SELECT count(*)::int AS n FROM webhook_delivery_attempts WHERE delivery_id = $1`,
      [rows[0].id],
    );
    expect(attempts.rows[0].n).toBe(0);
    expect(await pingAudits(hook.id)).toHaveLength(0);
    // It counts as a ping for the throttle... (the 500 path takes a moment, so only the range of
    // Retry-After is fixed: the contract itself is tested above)
    const refused = await ping(w.org.owner, hook.id);
    expect(refused.status, JSON.stringify(refused.body)).toBe(429);
    expect(refused.body.error.code).toBe('TOO_MANY_ATTEMPTS');
    expect(Number(refused.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(Number(refused.headers['retry-after'])).toBeLessThanOrEqual(10);
    // ... but never toward automatic disablement, and the maintenance sweep leaves it alone
    // (it has no job, so it is not an orphan) -- it simply stays pending.
    await ctx.services.webhookDelivery.runMaintenance();
    expect((await pingRows(hook.id))[0].status).toBe('pending');
    const endpointRow = (
      await sql(`SELECT status, consecutive_failures FROM webhook_endpoints WHERE id = $1`, [
        hook.id,
      ])
    ).rows[0];
    expect(endpointRow).toMatchObject({ status: 'active', consecutive_failures: 0 });
    // The next ping, after the interval, works normally; the old row remains pending.
    await setPingAge(hook.id, PING_MIN_INTERVAL_MS + 500);
    const next = await ping(w.org.owner, hook.id);
    expect(next.status, JSON.stringify(next.body)).toBe(200);
    expect(next.body.data.success).toBe(true);
    const all = await pingRows(hook.id);
    expect(all.map((r: { status: string }) => r.status).sort()).toEqual(['pending', 'succeeded']);
    // Known limitation (register, Step 7): the stale pending ping is included in the endpoint's
    // pending-delivery count that backs the queue ceiling.
    const pending = await sql(
      `SELECT count(*)::int AS n FROM webhook_deliveries WHERE endpoint_id = $1 AND status = 'pending'`,
      [hook.id],
    );
    expect(pending.rows[0].n).toBe(1);
  });
});

describe('automatic-disablement e-mail: who is notified', () => {
  const TEMPLATE = 'webhook-endpoint-auto-disabled';
  const mailsTo = (address: string) =>
    ctx.email.sent.filter((m) => m.template === TEMPLATE && m.to === address);
  const allWebhookMails = () => ctx.email.sent.filter((m) => m.template === TEMPLATE);

  interface Recipients {
    w: World;
    owner: AccountingOrg;
    responsible: { client: any; email: string; userId: string; membershipId: string };
    creator: { client: any; email: string; userId: string; membershipId: string };
    hook: Awaited<ReturnType<typeof endpoint>>;
  }

  /**
   * An organization whose integration is the responsibility of one administrator and whose
   * endpoint was created by another, with the Owner uninvolved. `same` makes them one person.
   */
  async function recipients(same = false): Promise<Recipients> {
    const org = await setUpAccountingOrg(ctx);
    const responsible = await joinWithRole(ctx, org.owner, 'Administrator');
    const creator = same ? responsible : await joinWithRole(ctx, org.owner, 'Administrator');
    const created = await org.owner.post('/api-integrations', {
      name: `Int ${randomUUID().slice(0, 6)}`,
      scopes: ['customers:read'],
      responsibleMembershipId: responsible.membershipId,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const w: World = { org, integrationId: created.body.data.id };
    const res = await creator.client.post('/webhooks/endpoints', {
      name: 'Notified',
      url: 'https://hooks.example.com/in',
      integrationId: w.integrationId,
      eventTypes: ['customer.created'],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return { w, owner: org, responsible, creator, hook: res.body.data };
  }

  /** One more dead letter at a count of 9 failures: the 10th disables the endpoint. */
  async function tenthFailure(r: Recipients) {
    await sql(
      `UPDATE webhook_endpoints
          SET status = 'active', disabled_at = NULL, disabled_reason = NULL, consecutive_failures = 9 WHERE id = $1`,
      [r.hook.id],
    );
    await newCustomer(r.w);
    await fanOutAll(r.owner.organizationId);
    await sql(
      `UPDATE webhook_deliveries SET cycle_attempts = 9, attempts_made = 9
        WHERE organization_id = $1 AND status = 'pending'`,
      [r.owner.organizationId],
    );
    await sql(
      `INSERT INTO webhook_delivery_attempts (organization_id, delivery_id, attempt_no, started_at, status_code, error_class)
       SELECT organization_id, id, g, now(), 500, 'http_status'
         FROM webhook_deliveries, generate_series(1, 9) g
        WHERE organization_id = $1 AND status = 'pending'`,
      [r.owner.organizationId],
    );
    transport.fail(500);
    await drain(r.owner.organizationId);
    transport.succeed();
    const row = (await sql(`SELECT status FROM webhook_endpoints WHERE id = $1`, [r.hook.id]))
      .rows[0];
    expect(row.status).toBe('auto_disabled');
  }
  const autoDisabledAudits = async (r: Recipients) =>
    (
      await sql(
        `SELECT actor_type FROM audit_events WHERE organization_id = (SELECT organization_id FROM webhook_endpoints WHERE id = $1::uuid) AND action = 'webhook_endpoint.auto_disabled' AND resource_id = $1::text`,
        [r.hook.id],
      )
    ).rows;

  it('notifies the responsible administrator and the creator once each, and nobody else', async () => {
    const r = await recipients();
    await tenthFailure(r);
    expect(mailsTo(r.responsible.email)).toHaveLength(1);
    expect(mailsTo(r.creator.email)).toHaveLength(1);
    expect(mailsTo(r.owner.ownerEmail)).toHaveLength(0); // an uninvolved Owner is not told
    expect(mailsTo(r.responsible.email)[0]!.subject).toContain('Notified');
    expect(await autoDisabledAudits(r)).toEqual([{ actor_type: 'system' }]);
  });

  it('sends one e-mail when the creator is also the responsible administrator', async () => {
    const r = await recipients(true);
    await tenthFailure(r);
    expect(mailsTo(r.creator.email)).toHaveLength(1);
    expect(allWebhookMails().filter((m) => m.to === r.creator.email)).toHaveLength(1);
  });

  it('skips inactive memberships and inactive user accounts, with no Owner fallback; the audit event stays', async () => {
    // An inactive membership (the responsible administrator was removed from the organization).
    const r = await recipients();
    const off = await r.owner.owner.patch(
      `/organizations/current/members/${r.responsible.membershipId}`,
      { status: 'disabled' },
    );
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    await tenthFailure(r);
    expect(mailsTo(r.responsible.email)).toHaveLength(0);
    expect(mailsTo(r.creator.email)).toHaveLength(1);

    // An inactive user account (the creator's account is disabled; the membership is still active).
    const r2 = await recipients();
    await sql(`UPDATE users SET status = 'disabled', disabled_at = now() WHERE id = $1`, [
      r2.creator.userId,
    ]);
    await tenthFailure(r2);
    expect(mailsTo(r2.creator.email)).toHaveLength(0);
    expect(mailsTo(r2.responsible.email)).toHaveLength(1);

    // Nobody eligible: no e-mail at all, no fallback to the Owner, and the audit event is written.
    const r3 = await recipients();
    expect(
      (
        await r3.owner.owner.patch(
          `/organizations/current/members/${r3.responsible.membershipId}`,
          {
            status: 'disabled',
          },
        )
      ).status,
    ).toBe(200);
    await sql(`UPDATE users SET status = 'disabled', disabled_at = now() WHERE id = $1`, [
      r3.creator.userId,
    ]);
    const total = allWebhookMails().length;
    await tenthFailure(r3);
    expect(allWebhookMails().length).toBe(total);
    for (const address of [r3.owner.ownerEmail, r3.responsible.email, r3.creator.email]) {
      expect(mailsTo(address), address).toHaveLength(0);
    }
    expect(await autoDisabledAudits(r3)).toEqual([{ actor_type: 'system' }]);
    expect(
      (
        await sql(`SELECT status, disabled_reason FROM webhook_endpoints WHERE id = $1`, [
          r3.hook.id,
        ])
      ).rows[0],
    ).toMatchObject({
      status: 'auto_disabled',
      disabled_reason: '10 consecutive failed deliveries',
    });
  });

  it('does not require a verified e-mail address', async () => {
    const r = await recipients();
    await sql(`UPDATE users SET email_verified_at = NULL WHERE id = ANY($1::uuid[])`, [
      [r.responsible.userId, r.creator.userId],
    ]);
    await tenthFailure(r);
    expect(mailsTo(r.responsible.email)).toHaveLength(1);
    expect(mailsTo(r.creator.email)).toHaveLength(1);
  });

  it('sends nothing when a person disables the endpoint manually', async () => {
    const r = await recipients();
    const before = allWebhookMails().length;
    const off = await r.owner.owner.post(`/webhooks/endpoints/${r.hook.id}/disable`, {
      version: r.hook.version,
      reason: 'maintenance',
    });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(off.body.data.status).toBe('disabled');
    expect(allWebhookMails().length).toBe(before);
    for (const address of [r.owner.ownerEmail, r.responsible.email, r.creator.email]) {
      expect(mailsTo(address), address).toHaveLength(0);
    }
    expect(await autoDisabledAudits(r)).toEqual([]);
  });

  it('does not fail the delivery or lose the disablement when the e-mail provider fails', async () => {
    const r = await recipients();
    const failing = vi.spyOn(ctx.email, 'send').mockRejectedValue(new Error('smtp is down'));
    const mailsBefore = allWebhookMails().length;
    let attempted: number;
    try {
      await tenthFailure(r); // asserts that the endpoint became auto_disabled
      attempted = failing.mock.calls.length;
    } finally {
      failing.mockRestore();
    }
    // The provider was asked and failed; nothing was recorded as sent. (The first failure stops
    // the loop over the recipients, so one call is enough to show the failure was reached.)
    expect(attempted).toBeGreaterThanOrEqual(1);
    expect(allWebhookMails().length).toBe(mailsBefore);
    // The audit event is written and the delivery ended as a dead letter, as without the failure.
    expect(await autoDisabledAudits(r)).toEqual([{ actor_type: 'system' }]);
    const dead = await sql(
      `SELECT count(*)::int AS n FROM webhook_deliveries WHERE endpoint_id = $1 AND status = 'dead'`,
      [r.hook.id],
    );
    expect(dead.rows[0].n).toBeGreaterThanOrEqual(1);
    // The problem is logged (and only logged); nothing was thrown to the delivery job.
    expect(ctx.logs.join('\n')).toContain('Webhook notification failed');
  });

  it('applies the same eligibility when the 3-day sweep disables the endpoint', async () => {
    const r = await recipients();
    const r2 = await recipients();
    await sql(
      `UPDATE users SET status = 'disabled', disabled_at = now() WHERE id = ANY($1::uuid[])`,
      [[r2.responsible.userId, r2.creator.userId]],
    );
    await sql(`UPDATE webhook_endpoints SET consecutive_failures = 2 WHERE id = ANY($1::uuid[])`, [
      [r.hook.id, r2.hook.id],
    ]);
    ctx.clock.advance(4 * DAY);
    await ctx.services.webhookDelivery.autoDisableStale();
    for (const x of [r, r2]) {
      expect(
        (await sql(`SELECT status FROM webhook_endpoints WHERE id = $1`, [x.hook.id])).rows[0]
          .status,
      ).toBe('auto_disabled');
      expect(await autoDisabledAudits(x)).toEqual([{ actor_type: 'system' }]);
    }
    expect(mailsTo(r.responsible.email)).toHaveLength(1);
    expect(mailsTo(r.creator.email)).toHaveLength(1);
    expect(mailsTo(r2.responsible.email)).toHaveLength(0);
    expect(mailsTo(r2.creator.email)).toHaveLength(0);
    expect(mailsTo(r2.owner.ownerEmail)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// MFA step-up for webhook management (ADR 0011 section 24, item 9). Last in the file: the tests
// advance the test clock. Same fixtures as the integration step-up test in api-integrations.test.ts.
// ---------------------------------------------------------------------------

describe('webhook management needs an MFA step-up when MFA applies; the ping does not', () => {
  const sleepPing = (client: any, id: string) => client.post(`/webhooks/endpoints/${id}/ping`, {});
  const agePings = (id: string) =>
    sql(
      `UPDATE webhook_deliveries SET created_at = created_at - interval '1 hour'
        WHERE endpoint_id = $1 AND event_type = 'webhook.ping'`,
      [id],
    );

  it('refuses a write without a recent second factor, accepts it after step-up, and never asks the ping for either', async () => {
    transport.succeed();
    const w = await world();
    const hook = await endpoint(w);
    // Owners always need MFA; observe every step by hand.
    w.org.owner.autoMfa = false;
    ctx.clock.advance(16 * MINUTE);
    await w.org.owner.get('/auth/session');
    // 1. Password confirmation first (unchanged order: re-authentication, then the second factor).
    const stale = await w.org.owner.post(`/webhooks/endpoints/${hook.id}/disable`, {
      version: hook.version,
    });
    expect(stale.body.error.code).toBe('REAUTHENTICATION_REQUIRED');
    // The ping is exempt from both: no password confirmation, no second factor.
    const pinged = await sleepPing(w.org.owner, hook.id);
    expect(pinged.status, JSON.stringify(pinged.body)).toBe(200);
    expect((await w.org.owner.reauthenticate()).status).toBe(200);
    // 2. Password confirmed, no recent second factor: the write is refused, nothing changed.
    const blocked = await w.org.owner.post(`/webhooks/endpoints/${hook.id}/disable`, {
      version: hook.version,
    });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('MFA_STEP_UP_REQUIRED');
    expect((await w.org.owner.get(`/webhooks/endpoints/${hook.id}`)).body.data).toMatchObject({
      status: 'active',
      version: hook.version,
    });
    // The other writes are guarded the same way, and reads never need it.
    const rotate = await w.org.owner.post(`/webhooks/endpoints/${hook.id}/rotate-secret`, {
      version: hook.version,
    });
    expect(rotate.body.error.code).toBe('MFA_STEP_UP_REQUIRED');
    const update = await w.org.owner.patch(`/webhooks/endpoints/${hook.id}`, {
      version: hook.version,
      name: 'Renamed',
    });
    expect(update.body.error.code).toBe('MFA_STEP_UP_REQUIRED');
    expect((await w.org.owner.get('/webhooks/endpoints')).status).toBe(200);
    // The ping is still exempt after the password confirmation, with the step-up still missing.
    await agePings(hook.id);
    expect((await sleepPing(w.org.owner, hook.id)).status).toBe(200);
    // 3. After the step-up the same operation succeeds.
    ctx.clock.advance(30_000);
    expect((await w.org.owner.stepUp()).status).toBe(200);
    const disabled = await w.org.owner.post(`/webhooks/endpoints/${hook.id}/disable`, {
      version: hook.version,
    });
    expect(disabled.status, JSON.stringify(disabled.body)).toBe(200);
    expect(disabled.body.data.status).toBe('disabled');
    // 4. The step-up window ends: the next write needs another second factor; the ping still does not.
    ctx.clock.advance(16 * MINUTE); // past the 15-minute step-up and re-authentication windows
    await w.org.owner.get('/auth/session');
    expect((await w.org.owner.reauthenticate()).status).toBe(200);
    const again = await w.org.owner.post(`/webhooks/endpoints/${hook.id}/enable`, {
      version: disabled.body.data.version,
    });
    expect(again.body.error.code).toBe('MFA_STEP_UP_REQUIRED');
    await agePings(hook.id);
    expect((await sleepPing(w.org.owner, hook.id)).status).toBe(200);
  });

  it('applies the same step-up to a non-privileged manager when the organization requires MFA of everyone', async () => {
    transport.succeed();
    const w = await world();
    const hook = await endpoint(w);
    const role = await w.org.owner.post('/organizations/current/roles', {
      name: 'Webhook manager',
      permissionKeys: ['webhooks.view', 'webhooks.manage'],
    });
    expect(role.status, JSON.stringify(role.body)).toBe(201);
    const manager = await joinWithRole(ctx, w.org.owner, 'Webhook manager');
    // Without the organization policy this role (no privileged permission, not the Owner) needs no
    // second factor for a webhook write, so the policy is what makes the difference below.
    const free = await manager.client.post(`/webhooks/endpoints/${hook.id}/disable`, {
      version: hook.version,
    });
    expect(free.status, JSON.stringify(free.body)).toBe(200);
    const enabledAgain = await manager.client.post(`/webhooks/endpoints/${hook.id}/ping`, {});
    expect(enabledAgain.status).toBe(200);
    const reenable = await manager.client.post(`/webhooks/endpoints/${hook.id}/enable`, {
      version: free.body.data.version,
    });
    expect(reenable.status, JSON.stringify(reenable.body)).toBe(200);
    // Switch the policy on (the Owner's harness answers the re-authentication and step-up).
    const policy = await w.org.owner.put('/organizations/current/security', {
      requireMfaForAllMembers: true,
      allowTrustedDevices: true,
      version: 0,
    });
    expect(policy.status, JSON.stringify(policy.body)).toBe(200);
    manager.client.autoMfa = false;
    await manager.client.enrollMfa();
    ctx.clock.advance(16 * MINUTE);
    await manager.client.get('/auth/session');
    expect((await manager.client.reauthenticate()).status).toBe(200);
    const current = (await manager.client.get(`/webhooks/endpoints/${hook.id}`)).body.data;
    const blocked = await manager.client.post(`/webhooks/endpoints/${hook.id}/disable`, {
      version: current.version,
    });
    expect(blocked.body.error.code).toBe('MFA_STEP_UP_REQUIRED');
    await agePings(hook.id);
    expect((await sleepPing(manager.client, hook.id)).status).toBe(200);
    ctx.clock.advance(30_000);
    expect((await manager.client.stepUp()).status).toBe(200);
    const ok = await manager.client.post(`/webhooks/endpoints/${hook.id}/disable`, {
      version: current.version,
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });
});
