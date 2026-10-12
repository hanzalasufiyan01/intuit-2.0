import { sql, type SQL } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';

/**
 * Persistence of webhook endpoints, subscriptions, deliveries and attempts (migration 0058). All
 * statements run in the caller's tenant transaction (RLS) and also filter by organization.
 */

export const ENDPOINT_STATUSES = ['active', 'disabled', 'auto_disabled'] as const;
export type EndpointStatus = (typeof ENDPOINT_STATUSES)[number];
export type PayloadMode = 'thin' | 'full';
export type DeliveryStatus = 'pending' | 'succeeded' | 'dead' | 'cancelled';

export interface SealedColumns {
  keyId: string;
  iv: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
}

export interface WebhookEndpoint {
  id: string;
  organizationId: string;
  integrationId: string;
  name: string;
  url: string;
  status: EndpointStatus;
  apiVersion: string;
  payloadMode: PayloadMode;
  secretVersion: number;
  secret: SealedColumns;
  prevSecret: (SealedColumns & { expiresAt: Date }) | null;
  consecutiveFailures: number;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  inFlight: number;
  inFlightUntil: Date | null;
  nextSendAt: Date | null;
  pingVerifiedAt: Date | null;
  disabledAt: Date | null;
  disabledByUserId: string | null;
  disabledReason: string | null;
  version: number;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface WebhookDelivery {
  id: string;
  organizationId: string;
  endpointId: string;
  eventId: string;
  eventType: string;
  outboxEventId: string | null;
  resourceType: string;
  resourceId: string;
  payload: Record<string, unknown>;
  status: DeliveryStatus;
  attemptsMade: number;
  cycleAttempts: number;
  redeliveryCount: number;
  lastStatusCode: number | null;
  lastErrorClass: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}

export interface WebhookAttempt {
  id: string;
  deliveryId: string;
  attemptNo: number;
  startedAt: Date;
  durationMs: number | null;
  statusCode: number | null;
  errorClass: string | null;
  responseExcerpt: string | null;
}

type Raw = Record<string, unknown>;
const date = (v: unknown) => (v === null || v === undefined ? null : new Date(v as string | Date));
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

function sealed(r: Raw, prefix: string): SealedColumns | null {
  const keyId = r[`${prefix}key_id`];
  if (keyId === null || keyId === undefined) return null;
  return {
    keyId: String(keyId),
    iv: r[`${prefix}iv`] as Buffer,
    tag: r[`${prefix}tag`] as Buffer,
    ciphertext: r[`${prefix}ciphertext`] as Buffer,
  };
}

function toEndpoint(r: Raw): WebhookEndpoint {
  const prev = sealed(r, 'prev_secret_');
  return {
    id: String(r.id),
    organizationId: String(r.organization_id),
    integrationId: String(r.integration_id),
    name: String(r.name),
    url: String(r.url),
    status: r.status as EndpointStatus,
    apiVersion: String(r.api_version),
    payloadMode: r.payload_mode as PayloadMode,
    secretVersion: Number(r.secret_version),
    secret: sealed(r, 'secret_')!,
    prevSecret: prev ? { ...prev, expiresAt: date(r.prev_secret_expires_at)! } : null,
    consecutiveFailures: Number(r.consecutive_failures),
    lastSuccessAt: date(r.last_success_at),
    lastFailureAt: date(r.last_failure_at),
    inFlight: Number(r.in_flight),
    inFlightUntil: date(r.in_flight_until),
    nextSendAt: date(r.next_send_at),
    pingVerifiedAt: date(r.ping_verified_at),
    disabledAt: date(r.disabled_at),
    disabledByUserId: (r.disabled_by_user_id as string | null) ?? null,
    disabledReason: (r.disabled_reason as string | null) ?? null,
    version: Number(r.version),
    createdByUserId: String(r.created_by_user_id),
    createdAt: date(r.created_at)!,
    updatedAt: date(r.updated_at)!,
    deletedAt: date(r.deleted_at),
  };
}

function toDelivery(r: Raw): WebhookDelivery {
  return {
    id: String(r.id),
    organizationId: String(r.organization_id),
    endpointId: String(r.endpoint_id),
    eventId: String(r.event_id),
    eventType: String(r.event_type),
    outboxEventId: (r.outbox_event_id as string | null) ?? null,
    resourceType: String(r.resource_type),
    resourceId: String(r.resource_id),
    payload: r.payload as Record<string, unknown>,
    status: r.status as DeliveryStatus,
    attemptsMade: Number(r.attempts_made),
    cycleAttempts: Number(r.cycle_attempts),
    redeliveryCount: Number(r.redelivery_count),
    lastStatusCode: num(r.last_status_code),
    lastErrorClass: (r.last_error_class as string | null) ?? null,
    createdAt: date(r.created_at)!,
    finishedAt: date(r.finished_at),
  };
}

const rows = async (tx: Transaction, query: SQL): Promise<Raw[]> =>
  (await tx.execute<Raw>(query)).rows;

// ---------------------------------------------------------------------------
// Endpoints and subscriptions
// ---------------------------------------------------------------------------

export interface NewEndpoint {
  id: string;
  organizationId: string;
  integrationId: string;
  name: string;
  url: string;
  payloadMode: PayloadMode;
  secret: SealedColumns;
  userId: string;
  now: Date;
}

export async function insertEndpoint(tx: Transaction, e: NewEndpoint): Promise<WebhookEndpoint> {
  const [row] = await rows(
    tx,
    sql`INSERT INTO webhook_endpoints
          (id, organization_id, integration_id, name, url, payload_mode, secret_key_id, secret_iv,
           secret_tag, secret_ciphertext, created_by_user_id, created_at, updated_at)
        VALUES (${e.id}::uuid, ${e.organizationId}::uuid, ${e.integrationId}::uuid, ${e.name}, ${e.url},
                ${e.payloadMode}, ${e.secret.keyId}, ${e.secret.iv}, ${e.secret.tag},
                ${e.secret.ciphertext}, ${e.userId}::uuid, ${e.now}, ${e.now})
        RETURNING *`,
  );
  return toEndpoint(row!);
}

export async function getEndpoint(
  tx: Transaction,
  organizationId: string,
  id: string,
  options: { forUpdate?: boolean; includeDeleted?: boolean } = {},
): Promise<WebhookEndpoint | undefined> {
  const [row] = await rows(
    tx,
    sql`SELECT * FROM webhook_endpoints
         WHERE organization_id = ${organizationId}::uuid AND id = ${id}::uuid
           ${options.includeDeleted ? sql`` : sql`AND deleted_at IS NULL`}
           ${options.forUpdate ? sql`FOR UPDATE` : sql``}`,
  );
  return row ? toEndpoint(row) : undefined;
}

export async function listEndpoints(
  tx: Transaction,
  organizationId: string,
): Promise<WebhookEndpoint[]> {
  return (
    await rows(
      tx,
      sql`SELECT * FROM webhook_endpoints
           WHERE organization_id = ${organizationId}::uuid AND deleted_at IS NULL
           ORDER BY created_at, id`,
    )
  ).map(toEndpoint);
}

export async function countLiveEndpoints(tx: Transaction, organizationId: string): Promise<number> {
  const [row] = await rows(
    tx,
    sql`SELECT count(*)::int AS n FROM webhook_endpoints
         WHERE organization_id = ${organizationId}::uuid AND deleted_at IS NULL`,
  );
  return Number(row!.n);
}

/** Columns an update may set (all others are immutable or have their own functions). */
export interface EndpointChanges {
  name?: string;
  url?: string;
  payloadMode?: PayloadMode;
  status?: EndpointStatus;
  disabledAt?: Date | null;
  disabledByUserId?: string | null;
  disabledReason?: string | null;
  secretVersion?: number;
  secret?: SealedColumns;
  prevSecret?: (SealedColumns & { expiresAt: Date }) | null;
  consecutiveFailures?: number;
  lastSuccessAt?: Date;
  lastFailureAt?: Date;
  pingVerifiedAt?: Date | null;
  deletedAt?: Date;
  deletedByUserId?: string;
}

const COLUMN: Record<string, string> = {
  name: 'name',
  url: 'url',
  payloadMode: 'payload_mode',
  status: 'status',
  disabledAt: 'disabled_at',
  disabledByUserId: 'disabled_by_user_id',
  disabledReason: 'disabled_reason',
  secretVersion: 'secret_version',
  consecutiveFailures: 'consecutive_failures',
  lastSuccessAt: 'last_success_at',
  lastFailureAt: 'last_failure_at',
  pingVerifiedAt: 'ping_verified_at',
  deletedAt: 'deleted_at',
  deletedByUserId: 'deleted_by_user_id',
};

/** Applies changes to an endpoint (optionally only at the expected version) and advances `version`. */
export async function updateEndpoint(
  tx: Transaction,
  input: {
    organizationId: string;
    id: string;
    expectedVersion?: number;
    changes: EndpointChanges;
    /** False for bookkeeping (counters, last success, ping): only people's changes advance `version`. */
    bumpVersion?: boolean;
    userId: string | null;
    now: Date;
  },
): Promise<WebhookEndpoint | undefined> {
  const sets: SQL[] = [];
  const { changes } = input;
  for (const [key, column] of Object.entries(COLUMN)) {
    const value = (changes as Record<string, unknown>)[key];
    if (value !== undefined) {
      const cast = column.endsWith('_by_user_id') ? sql`::uuid` : sql``;
      sets.push(sql`${sql.raw(column)} = ${value}${cast}`);
    }
  }
  if (changes.secret) {
    sets.push(
      sql`secret_key_id = ${changes.secret.keyId}, secret_iv = ${changes.secret.iv},
          secret_tag = ${changes.secret.tag}, secret_ciphertext = ${changes.secret.ciphertext}`,
    );
  }
  if (changes.prevSecret !== undefined) {
    const p = changes.prevSecret;
    sets.push(
      p
        ? sql`prev_secret_key_id = ${p.keyId}, prev_secret_iv = ${p.iv}, prev_secret_tag = ${p.tag},
              prev_secret_ciphertext = ${p.ciphertext}, prev_secret_expires_at = ${p.expiresAt}`
        : sql`prev_secret_key_id = NULL, prev_secret_iv = NULL, prev_secret_tag = NULL,
              prev_secret_ciphertext = NULL, prev_secret_expires_at = NULL`,
    );
  }
  sets.push(
    input.bumpVersion === false
      ? sql`updated_at = ${input.now}`
      : sql`version = version + 1, updated_at = ${input.now}`,
  );
  if (input.userId) sets.push(sql`updated_by_user_id = ${input.userId}::uuid`);
  const [row] = await rows(
    tx,
    sql`UPDATE webhook_endpoints SET ${sql.join(sets, sql`, `)}
         WHERE organization_id = ${input.organizationId}::uuid AND id = ${input.id}::uuid
           AND deleted_at IS NULL
           ${input.expectedVersion === undefined ? sql`` : sql`AND version = ${input.expectedVersion}`}
         RETURNING *`,
  );
  return row ? toEndpoint(row) : undefined;
}

export async function listSubscriptions(
  tx: Transaction,
  organizationId: string,
  endpointIds: readonly string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (endpointIds.length === 0) return out;
  const found = await rows(
    tx,
    sql`SELECT endpoint_id, event_type FROM webhook_subscriptions
         WHERE organization_id = ${organizationId}::uuid
           AND endpoint_id IN (${sql.join(
             endpointIds.map((id) => sql`${id}::uuid`),
             sql`, `,
           )})
         ORDER BY event_type`,
  );
  for (const r of found) {
    const list = out.get(String(r.endpoint_id)) ?? [];
    list.push(String(r.event_type));
    out.set(String(r.endpoint_id), list);
  }
  return out;
}

export async function replaceSubscriptions(
  tx: Transaction,
  organizationId: string,
  endpointId: string,
  eventTypes: readonly string[],
  now: Date,
): Promise<void> {
  await tx.execute(
    sql`DELETE FROM webhook_subscriptions
         WHERE organization_id = ${organizationId}::uuid AND endpoint_id = ${endpointId}::uuid`,
  );
  for (const type of eventTypes) {
    await tx.execute(
      sql`INSERT INTO webhook_subscriptions (endpoint_id, organization_id, event_type, created_at)
          VALUES (${endpointId}::uuid, ${organizationId}::uuid, ${type}, ${now})`,
    );
  }
}

/** Live, active endpoints of the organization subscribed to an event type (fan-out). */
export async function endpointsSubscribedTo(
  tx: Transaction,
  organizationId: string,
  eventType: string,
): Promise<WebhookEndpoint[]> {
  return (
    await rows(
      tx,
      sql`SELECT e.* FROM webhook_endpoints e
            JOIN webhook_subscriptions s
              ON s.endpoint_id = e.id AND s.organization_id = e.organization_id
           WHERE e.organization_id = ${organizationId}::uuid AND e.deleted_at IS NULL
             AND e.status = 'active' AND s.event_type = ${eventType}
           ORDER BY e.created_at, e.id`,
    )
  ).map(toEndpoint);
}

// ---------------------------------------------------------------------------
// Delivery throttling (bounded concurrency + minimum spacing per endpoint)
// ---------------------------------------------------------------------------

/**
 * Claims one send slot of an endpoint: fewer than `concurrency` sends in flight (a stale lease
 * counts as free) and at least `minIntervalMs` since the previous send started. Returns 0 when
 * claimed, otherwise the milliseconds to wait.
 */
export async function claimSendSlot(
  tx: Transaction,
  input: {
    organizationId: string;
    endpointId: string;
    concurrency: number;
    minIntervalMs: number;
    leaseMs: number;
    now: Date;
  },
): Promise<number> {
  const [claimed] = await rows(
    tx,
    sql`UPDATE webhook_endpoints
           SET in_flight = CASE WHEN in_flight_until IS NULL OR in_flight_until <= ${input.now}
                                THEN 1 ELSE in_flight + 1 END,
               in_flight_until = ${new Date(input.now.getTime() + input.leaseMs)},
               next_send_at = ${new Date(input.now.getTime() + input.minIntervalMs)}
         WHERE organization_id = ${input.organizationId}::uuid AND id = ${input.endpointId}::uuid
           AND (next_send_at IS NULL OR next_send_at <= ${input.now})
           AND (in_flight < ${input.concurrency} OR in_flight_until IS NULL
                OR in_flight_until <= ${input.now})
         RETURNING id`,
  );
  if (claimed) return 0;
  const [current] = await rows(
    tx,
    sql`SELECT next_send_at, in_flight_until FROM webhook_endpoints
         WHERE organization_id = ${input.organizationId}::uuid AND id = ${input.endpointId}::uuid`,
  );
  const spacing = (date(current?.next_send_at)?.getTime() ?? 0) - input.now.getTime();
  const lease = (date(current?.in_flight_until)?.getTime() ?? 0) - input.now.getTime();
  return Math.max(Math.min(Math.max(spacing, 0) || 250, Math.max(lease, 250)), 100);
}

export async function releaseSendSlot(
  tx: Transaction,
  organizationId: string,
  endpointId: string,
): Promise<void> {
  await tx.execute(
    sql`UPDATE webhook_endpoints SET in_flight = greatest(in_flight - 1, 0)
         WHERE organization_id = ${organizationId}::uuid AND id = ${endpointId}::uuid`,
  );
}

// ---------------------------------------------------------------------------
// Deliveries and attempts
// ---------------------------------------------------------------------------

export interface NewDelivery {
  organizationId: string;
  endpointId: string;
  eventId: string;
  eventType: string;
  outboxEventId: string | null;
  resourceType: string;
  resourceId: string;
  payload: Record<string, unknown>;
  status?: DeliveryStatus;
  errorClass?: string | null;
  now: Date;
}

/** Inserts a delivery; null when this event was already fanned out to the endpoint (idempotent). */
export async function insertDelivery(
  tx: Transaction,
  d: NewDelivery,
): Promise<WebhookDelivery | null> {
  const status = d.status ?? 'pending';
  const [row] = await rows(
    tx,
    sql`INSERT INTO webhook_deliveries
          (organization_id, endpoint_id, event_id, event_type, outbox_event_id, resource_type,
           resource_id, payload, status, last_error_class, created_at, finished_at)
        VALUES (${d.organizationId}::uuid, ${d.endpointId}::uuid, ${d.eventId}, ${d.eventType},
                ${d.outboxEventId}::uuid, ${d.resourceType}, ${d.resourceId},
                ${JSON.stringify(d.payload)}::jsonb, ${status}, ${d.errorClass ?? null}, ${d.now},
                ${status === 'pending' ? null : d.now})
        ON CONFLICT (outbox_event_id, endpoint_id) WHERE outbox_event_id IS NOT NULL DO NOTHING
        RETURNING *`,
  );
  return row ? toDelivery(row) : null;
}

export async function getDelivery(
  tx: Transaction,
  organizationId: string,
  id: string,
  options: { forUpdate?: boolean } = {},
): Promise<WebhookDelivery | undefined> {
  const [row] = await rows(
    tx,
    sql`SELECT * FROM webhook_deliveries
         WHERE organization_id = ${organizationId}::uuid AND id = ${id}::uuid
         ${options.forUpdate ? sql`FOR UPDATE` : sql``}`,
  );
  return row ? toDelivery(row) : undefined;
}

export async function countPendingDeliveries(
  tx: Transaction,
  organizationId: string,
  endpointId: string,
): Promise<number> {
  const [row] = await rows(
    tx,
    sql`SELECT count(*)::int AS n FROM webhook_deliveries
         WHERE organization_id = ${organizationId}::uuid AND endpoint_id = ${endpointId}::uuid
           AND status = 'pending'`,
  );
  return Number(row!.n);
}

export async function listDeliveries(
  tx: Transaction,
  input: {
    organizationId: string;
    endpointId?: string;
    status?: DeliveryStatus;
    limit: number;
    before?: { createdAt: Date; id: string };
  },
): Promise<WebhookDelivery[]> {
  const conditions: SQL[] = [sql`organization_id = ${input.organizationId}::uuid`];
  if (input.endpointId) conditions.push(sql`endpoint_id = ${input.endpointId}::uuid`);
  if (input.status) conditions.push(sql`status = ${input.status}`);
  if (input.before) {
    conditions.push(sql`(created_at, id) < (${input.before.createdAt}, ${input.before.id}::uuid)`);
  }
  return (
    await rows(
      tx,
      sql`SELECT * FROM webhook_deliveries WHERE ${sql.join(conditions, sql` AND `)}
           ORDER BY created_at DESC, id DESC LIMIT ${input.limit}`,
    )
  ).map(toDelivery);
}

export interface DeliveryChanges {
  status?: DeliveryStatus;
  attemptsMade?: number;
  cycleAttempts?: number;
  redeliveryCount?: number;
  lastStatusCode?: number | null;
  lastErrorClass?: string | null;
  finishedAt?: Date | null;
}

export async function updateDelivery(
  tx: Transaction,
  organizationId: string,
  id: string,
  changes: DeliveryChanges,
): Promise<WebhookDelivery | undefined> {
  const sets: SQL[] = [];
  const map: [keyof DeliveryChanges, string][] = [
    ['status', 'status'],
    ['attemptsMade', 'attempts_made'],
    ['cycleAttempts', 'cycle_attempts'],
    ['redeliveryCount', 'redelivery_count'],
    ['lastStatusCode', 'last_status_code'],
    ['lastErrorClass', 'last_error_class'],
    ['finishedAt', 'finished_at'],
  ];
  for (const [key, column] of map) {
    if (changes[key] !== undefined) sets.push(sql`${sql.raw(column)} = ${changes[key]}`);
  }
  const [row] = await rows(
    tx,
    sql`UPDATE webhook_deliveries SET ${sql.join(sets, sql`, `)}
         WHERE organization_id = ${organizationId}::uuid AND id = ${id}::uuid RETURNING *`,
  );
  return row ? toDelivery(row) : undefined;
}

export async function insertAttempt(
  tx: Transaction,
  a: {
    organizationId: string;
    deliveryId: string;
    attemptNo: number;
    startedAt: Date;
    durationMs: number | null;
    statusCode: number | null;
    errorClass: string | null;
    responseExcerpt: string | null;
  },
): Promise<void> {
  await tx.execute(
    sql`INSERT INTO webhook_delivery_attempts
          (organization_id, delivery_id, attempt_no, started_at, duration_ms, status_code,
           error_class, response_excerpt)
        VALUES (${a.organizationId}::uuid, ${a.deliveryId}::uuid, ${a.attemptNo}, ${a.startedAt},
                ${a.durationMs}, ${a.statusCode}, ${a.errorClass}, ${a.responseExcerpt})`,
  );
}

export async function listAttempts(
  tx: Transaction,
  organizationId: string,
  deliveryId: string,
): Promise<WebhookAttempt[]> {
  return (
    await rows(
      tx,
      sql`SELECT * FROM webhook_delivery_attempts
           WHERE organization_id = ${organizationId}::uuid AND delivery_id = ${deliveryId}::uuid
           ORDER BY attempt_no`,
    )
  ).map((r) => ({
    id: String(r.id),
    deliveryId: String(r.delivery_id),
    attemptNo: Number(r.attempt_no),
    startedAt: date(r.started_at)!,
    durationMs: num(r.duration_ms),
    statusCode: num(r.status_code),
    errorClass: (r.error_class as string | null) ?? null,
    responseExcerpt: (r.response_excerpt as string | null) ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

export async function organizationsWithWebhooks(tx: Transaction): Promise<string[]> {
  return (await rows(tx, sql`SELECT organization_id FROM app_organizations_with_webhooks()`)).map(
    (r) => String(r.organization_id),
  );
}

export async function purgeWebhookHistory(
  tx: Transaction,
  cutoff: Date,
  limit: number,
): Promise<number> {
  const [row] = await rows(tx, sql`SELECT app_purge_webhook_history(${cutoff}, ${limit}) AS n`);
  return Number(row!.n);
}

export async function purgePublicOutbox(
  tx: Transaction,
  cutoff: Date,
  limit: number,
): Promise<number> {
  const [row] = await rows(tx, sql`SELECT app_purge_public_outbox(${cutoff}, ${limit}) AS n`);
  return Number(row!.n);
}

/** Active endpoints with failed deliveries since their last success and no success for `staleBefore`. */
export async function staleEndpoints(
  tx: Transaction,
  organizationId: string,
  staleBefore: Date,
): Promise<WebhookEndpoint[]> {
  return (
    await rows(
      tx,
      sql`SELECT * FROM webhook_endpoints
           WHERE organization_id = ${organizationId}::uuid AND deleted_at IS NULL
             AND status = 'active' AND consecutive_failures >= 1
             AND coalesce(last_success_at, created_at) < ${staleBefore}`,
    )
  ).map(toEndpoint);
}

/** Pending deliveries whose delivery job already ended unsuccessfully (a lost job): they can never run. */
export async function orphanedDeliveries(
  tx: Transaction,
  organizationId: string,
): Promise<WebhookDelivery[]> {
  return (
    await rows(
      tx,
      sql`SELECT d.* FROM webhook_deliveries d
            JOIN jobs j ON j.organization_id = d.organization_id AND j.type = 'webhook.deliver'
                       AND j.payload ->> 'deliveryId' = d.id::text
           WHERE d.organization_id = ${organizationId}::uuid AND d.status = 'pending'
             AND j.status IN ('failed', 'dead')
             AND NOT EXISTS (SELECT 1 FROM jobs j2
                              WHERE j2.organization_id = d.organization_id AND j2.type = 'webhook.deliver'
                                AND j2.payload ->> 'deliveryId' = d.id::text
                                AND j2.status IN ('queued', 'running'))`,
    )
  ).map(toDelivery);
}
