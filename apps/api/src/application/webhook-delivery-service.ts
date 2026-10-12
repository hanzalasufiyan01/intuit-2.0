import type { Transaction } from '../database/client.js';
import { recordAuditEvent } from '../modules/audit/index.js';
import { getIntegration } from '../modules/api-integrations/index.js';
import { findMembershipById } from '../modules/organizations/index.js';
import { getUserProfiles } from '../modules/identity/index.js';
import { RetryAfterError } from '../modules/jobs/index.js';
import type { OutboxDispatcher, OutboxEvent } from '../modules/outbox/index.js';
import {
  DOMAIN_PUBLIC_EVENT_TYPES,
  publicOutboxType,
  type PublicEventPayload,
} from '../modules/public-events/index.js';
import {
  claimSendSlot,
  countPendingDeliveries,
  endpointsSubscribedTo,
  FULL_MODE_RESOURCES,
  getDelivery,
  getEndpoint,
  insertAttempt,
  insertDelivery,
  orphanedDeliveries,
  organizationsWithWebhooks,
  purgePublicOutbox,
  purgeWebhookHistory,
  readPermissionOfEvent,
  releaseSendSlot,
  signatureHeader,
  staleEndpoints,
  updateDelivery,
  updateEndpoint,
  WebhookDestinationError,
  WebhookTransportError,
  type WebhookDelivery,
  type WebhookEndpoint,
  type WebhookSecretCipher,
  type WebhookTransport,
} from '../modules/webhooks/index.js';
import { effectiveIntegrationPermissions } from './integration-auth-service.js';
import type { AppDependencies } from './dependencies.js';
import type { JobContext, JobService } from './job-service.js';
import { inTransaction } from './unit-of-work.js';
import { AppError } from '../domain/errors.js';

/**
 * Webhook fan-out and delivery (ADR 0011 sections 11.1, 11.5, 18.8, 19.4 and 19.6).
 *
 *   outbox `public.*` row ──fan-out (idempotent)──► webhook_deliveries + job `webhook.deliver`
 *   job ──► [tx: re-checks, throttle slot, body, secrets] ──► HTTPS (NO transaction open) ──►
 *           [tx: attempt row, outcome, retry / dead letter / auto-disable]
 *
 * No network request is ever made inside a business transaction, and a delivery can never change
 * accounting data: it reads the organization's own resource under RLS and writes only webhook
 * tables. Retries use the frozen schedule through the existing job queue (`RetryAfterError`).
 */

export const WEBHOOK_DELIVER_JOB = 'webhook.deliver';

/** Frozen retry schedule after failed attempt 1..9 (±20% jitter); the 10th failure is terminal. */
export const RETRY_SCHEDULE_MS = [
  30_000, 120_000, 600_000, 1_800_000, 3_600_000, 10_800_000, 21_600_000, 43_200_000, 86_400_000,
] as const;
export const MAX_DELIVERY_ATTEMPTS = RETRY_SCHEDULE_MS.length + 1;
/** D6: 10 consecutive dead-lettered deliveries, or 3 days without a success. */
export const AUTO_DISABLE_FAILURES = 10;
export const AUTO_DISABLE_AFTER_MS = 3 * 24 * 60 * 60 * 1000;
/** Crash headroom above the 10 real attempts (throttling gives its attempts back). */
const JOB_ATTEMPT_CEILING = MAX_DELIVERY_ATTEMPTS + 2;

export function retryDelayMs(attemptsMade: number, random: () => number = Math.random): number {
  const base = RETRY_SCHEDULE_MS[Math.min(attemptsMade, RETRY_SCHEDULE_MS.length) - 1]!;
  return Math.round(base * (1 + (random() * 2 - 1) * 0.2));
}

/** Builds the public object of a resource for `full` endpoints (injected by the API layer). */
export type ObjectRenderer = (
  tx: Transaction,
  organizationId: string,
  resourceType: string,
  resourceId: string,
) => Promise<unknown | null>;

export interface AttemptOutcome {
  success: boolean;
  statusCode: number | null;
  errorClass: string | null;
  excerpt: string | null;
  durationMs: number;
}

const SYSTEM_ORIGIN = { requestId: 'webhook', ipAddress: null, userAgent: null };

export class WebhookDeliveryService {
  constructor(
    private readonly deps: AppDependencies,
    private readonly jobs: JobService,
    private readonly transport: WebhookTransport,
    private readonly cipher: WebhookSecretCipher | null,
    private readonly renderObject: ObjectRenderer,
    private readonly random: () => number = Math.random,
  ) {}

  private get now() {
    return this.deps.clock.now();
  }

  private get settings() {
    return this.deps.config.webhooks;
  }

  private audit(
    tx: Transaction,
    organizationId: string,
    action: string,
    resourceType: string,
    resourceId: string,
    metadata: Record<string, unknown>,
  ) {
    return recordAuditEvent(tx, {
      occurredAt: this.now,
      organizationId,
      actorUserId: null,
      actorType: 'system',
      action,
      resourceType,
      resourceId,
      metadata,
      origin: SYSTEM_ORIGIN,
    });
  }

  // ---------------------------------------------------------------------------
  // Authorization re-check (fan-out and delivery)
  // ---------------------------------------------------------------------------

  /**
   * Whether the endpoint's integration may still receive this event type: the integration is
   * active and its CURRENT effective permissions (scopes within the platform policy within the
   * organization boundary) include the read permission of the event's resource.
   */
  private async mayReceive(
    tx: Transaction,
    cache: Map<string, Set<string> | null>,
    organizationId: string,
    integrationId: string,
    eventType: string,
  ): Promise<boolean> {
    if (eventType === 'webhook.ping') return true;
    const required = readPermissionOfEvent(eventType);
    if (!required) return false;
    if (!cache.has(integrationId)) {
      const integration = await getIntegration(tx, organizationId, integrationId);
      cache.set(
        integrationId,
        integration?.status === 'active'
          ? await effectiveIntegrationPermissions(tx, organizationId, integrationId)
          : null,
      );
    }
    return cache.get(integrationId)?.has(required) ?? false;
  }

  // ---------------------------------------------------------------------------
  // Fan-out
  // ---------------------------------------------------------------------------

  /**
   * The outbox subscriber for one `public.*` event. Idempotent: a repeated or retried call creates
   * nothing new (unique per outbox event and endpoint). Organizations without a subscribed
   * endpoint are a single cheap query. Deliveries are created pending and handed to the job queue;
   * nothing is sent here.
   */
  async fanOut(event: OutboxEvent): Promise<{ created: number; skipped: number }> {
    const payload = event.payload as unknown as PublicEventPayload;
    const organizationId = event.organizationId;
    if (!organizationId || !payload?.type || payload.organization_id !== organizationId) {
      return { created: 0, skipped: 0 };
    }
    const notifications: WebhookEndpoint[] = [];
    const result = await inTransaction(this.deps.db, { organizationId }, async (tx) => {
      const endpoints = await endpointsSubscribedTo(tx, organizationId, payload.type);
      let created = 0;
      let skipped = 0;
      const cache = new Map<string, Set<string> | null>();
      for (const endpoint of endpoints) {
        // Scopes are re-checked for every event: a removed scope creates no delivery.
        if (
          !(await this.mayReceive(tx, cache, organizationId, endpoint.integrationId, payload.type))
        ) {
          skipped += 1;
          continue;
        }
        const base = {
          organizationId,
          endpointId: endpoint.id,
          eventId: payload.id,
          eventType: payload.type,
          outboxEventId: event.id,
          resourceType: payload.resource.type,
          resourceId: payload.resource.id,
          payload: payload as unknown as Record<string, unknown>,
          now: this.now,
        };
        // Queue ceiling: beyond it the delivery is dead-lettered at once (counts toward D6).
        if (
          (await countPendingDeliveries(tx, organizationId, endpoint.id)) >=
          this.settings.endpointQueueCeiling
        ) {
          const delivery = await insertDelivery(tx, {
            ...base,
            status: 'dead',
            errorClass: 'queue_full',
          });
          if (delivery) {
            const disabled = await this.registerFailure(
              tx,
              organizationId,
              endpoint.id,
              delivery.id,
            );
            if (disabled) notifications.push(disabled);
            created += 1;
          }
          continue;
        }
        const delivery = await insertDelivery(tx, base);
        if (!delivery) continue; // already fanned out
        await this.enqueue(tx, delivery);
        created += 1;
      }
      return { created, skipped };
    });
    for (const endpoint of notifications) await this.notifyAutoDisabled(endpoint);
    return result;
  }

  /** Enqueues the delivery job (idempotent per delivery and redelivery count). */
  enqueue(tx: Transaction, delivery: WebhookDelivery) {
    return this.jobs.enqueue(tx, {
      organizationId: delivery.organizationId,
      type: WEBHOOK_DELIVER_JOB,
      jobKey: `${WEBHOOK_DELIVER_JOB}:${delivery.id}:${delivery.redeliveryCount}`,
      payload: { deliveryId: delivery.id },
      maxAttempts: JOB_ATTEMPT_CEILING,
    });
  }

  /** Subscribes the fan-out to every public event type on the (shared) outbox dispatcher. */
  registerFanOut(dispatcher: OutboxDispatcher): void {
    for (const type of DOMAIN_PUBLIC_EVENT_TYPES) {
      dispatcher.subscribe(
        publicOutboxType(type),
        async (event) => void (await this.fanOut(event)),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Delivery job
  // ---------------------------------------------------------------------------

  private requireCipher(): WebhookSecretCipher {
    if (!this.cipher) {
      throw new AppError('WEBHOOKS_NOT_CONFIGURED', 503, 'Webhook signing is not configured.');
    }
    return this.cipher;
  }

  /** The valid signing secrets, newest first: the previous one only during its overlap. */
  secretsOf(endpoint: WebhookEndpoint): string[] {
    const cipher = this.requireCipher();
    const secrets = [cipher.open(endpoint.secret, endpoint.id, endpoint.secretVersion, 'current')];
    if (endpoint.prevSecret && endpoint.prevSecret.expiresAt.getTime() > this.now.getTime()) {
      secrets.push(
        cipher.open(endpoint.prevSecret, endpoint.id, endpoint.secretVersion, 'previous'),
      );
    }
    return secrets;
  }

  /** The raw JSON body: the stored thin envelope, plus `data.object` for `full` endpoints. */
  async bodyOf(tx: Transaction, endpoint: WebhookEndpoint, delivery: WebhookDelivery) {
    const envelope = structuredClone(delivery.payload) as Record<string, unknown> & {
      data: Record<string, unknown>;
      resource: { type: string; id: string };
    };
    if (
      endpoint.payloadMode === 'full' &&
      (FULL_MODE_RESOURCES as readonly string[]).includes(envelope.resource.type)
    ) {
      const object = await this.renderObject(
        tx,
        delivery.organizationId,
        envelope.resource.type,
        envelope.resource.id,
      );
      // "The state at or after the event", never a guaranteed historical snapshot.
      if (object) envelope.data = { ...envelope.data, object };
    }
    return JSON.stringify(envelope);
  }

  /** One signed request. Never throws; the outcome says what happened. */
  async attempt(input: {
    url: string;
    secrets: readonly string[];
    deliveryId: string;
    eventType: string;
    body: string;
  }): Promise<AttemptOutcome> {
    const timestamp = Math.floor(this.now.getTime() / 1000);
    try {
      const response = await this.transport.send({
        url: input.url,
        body: input.body,
        headers: {
          'content-type': 'application/json',
          'user-agent': 'Intuit-Webhooks/1',
          'intuit-webhook-id': input.deliveryId,
          'intuit-webhook-event': input.eventType,
          'intuit-webhook-timestamp': String(timestamp),
          'intuit-webhook-signature': signatureHeader(
            input.secrets,
            timestamp,
            input.deliveryId,
            input.body,
          ),
        },
      });
      const success = response.statusCode >= 200 && response.statusCode < 300;
      return {
        success,
        statusCode: response.statusCode,
        errorClass: success
          ? null
          : response.statusCode >= 300 && response.statusCode < 400
            ? 'redirect'
            : 'http_status',
        excerpt: response.excerpt,
        durationMs: response.durationMs,
      };
    } catch (error) {
      const errorClass =
        error instanceof WebhookTransportError || error instanceof WebhookDestinationError
          ? error.errorClass
          : 'internal';
      return {
        success: false,
        statusCode: null,
        errorClass,
        excerpt: null,
        durationMs: error instanceof WebhookTransportError ? error.durationMs : 0,
      };
    }
  }

  /** The `webhook.deliver` job handler: exactly one attempt per run. */
  async handleJob(job: JobContext): Promise<Record<string, unknown> | void> {
    const organizationId = job.organizationId;
    const deliveryId = String(job.job.payload.deliveryId ?? '');

    // 1. Re-checks, throttle slot, body and secrets (one short transaction).
    const prepared = await job.run(async (tx) => {
      const delivery = await getDelivery(tx, organizationId, deliveryId, { forUpdate: true });
      if (!delivery || delivery.status !== 'pending') return { kind: 'skip' as const };
      const endpoint = await getEndpoint(tx, organizationId, delivery.endpointId, {
        includeDeleted: true,
      });
      if (!endpoint || endpoint.deletedAt || endpoint.status !== 'active') {
        await this.cancel(tx, delivery, 'endpoint_inactive');
        return { kind: 'skip' as const };
      }
      const allowed = await this.mayReceive(
        tx,
        new Map(),
        organizationId,
        endpoint.integrationId,
        delivery.eventType,
      );
      if (!allowed) {
        // A scope removed after fan-out cancels the pending delivery here (section 19.6).
        await this.cancel(tx, delivery, 'scope_revoked');
        return { kind: 'skip' as const };
      }
      const wait = await claimSendSlot(tx, {
        organizationId,
        endpointId: endpoint.id,
        concurrency: this.settings.endpointConcurrency,
        minIntervalMs: this.settings.endpointMinIntervalMs,
        leaseMs: 30_000,
        now: this.now,
      });
      if (wait > 0) return { kind: 'defer' as const, wait };
      try {
        const secrets = this.secretsOf(endpoint);
        const body = await this.bodyOf(tx, endpoint, delivery);
        return { kind: 'send' as const, endpoint, delivery, secrets, body };
      } catch (error) {
        await releaseSendSlot(tx, organizationId, endpoint.id);
        throw error;
      }
    });
    if (prepared.kind === 'skip') return { skipped: true };
    // Waiting for a free slot is not a failed attempt: the attempt is given back.
    if (prepared.kind === 'defer') throw new RetryAfterError(prepared.wait, 'throttled', false);

    // 2. The network request: no transaction is open.
    const { endpoint, delivery } = prepared;
    const startedAt = this.now;
    const outcome = await this.attempt({
      url: endpoint.url,
      secrets: prepared.secrets,
      deliveryId: delivery.id,
      eventType: delivery.eventType,
      body: prepared.body,
    });

    // 3. Record the attempt and decide: delivered, retry, or dead letter (+ auto-disable).
    const decision = await job.run(async (tx) => {
      await releaseSendSlot(tx, organizationId, endpoint.id);
      const current = (await getDelivery(tx, organizationId, delivery.id, { forUpdate: true }))!;
      const attemptNo = current.attemptsMade + 1;
      const cycle = current.cycleAttempts + 1;
      await insertAttempt(tx, {
        organizationId,
        deliveryId: delivery.id,
        attemptNo,
        startedAt,
        durationMs: outcome.durationMs,
        statusCode: outcome.statusCode,
        errorClass: outcome.errorClass,
        responseExcerpt: outcome.excerpt,
      });
      const common = {
        attemptsMade: attemptNo,
        cycleAttempts: cycle,
        lastStatusCode: outcome.statusCode,
        lastErrorClass: outcome.errorClass,
      };
      if (outcome.success) {
        await updateDelivery(tx, organizationId, delivery.id, {
          ...common,
          status: 'succeeded',
          finishedAt: this.now,
        });
        await updateEndpoint(tx, {
          organizationId,
          id: endpoint.id,
          changes: { consecutiveFailures: 0, lastSuccessAt: this.now },
          bumpVersion: false,
          userId: null,
          now: this.now,
        });
        return { kind: 'delivered' as const };
      }
      if (cycle >= MAX_DELIVERY_ATTEMPTS) {
        await updateDelivery(tx, organizationId, delivery.id, {
          ...common,
          status: 'dead',
          finishedAt: this.now,
        });
        const disabled = await this.registerFailure(tx, organizationId, endpoint.id, delivery.id);
        await this.audit(
          tx,
          organizationId,
          'webhook_delivery.dead_lettered',
          'webhook_delivery',
          delivery.id,
          {
            endpointId: endpoint.id,
            eventType: delivery.eventType,
            attempts: attemptNo,
            errorClass: outcome.errorClass,
            statusCode: outcome.statusCode,
          },
        );
        return { kind: 'dead' as const, disabled };
      }
      await updateDelivery(tx, organizationId, delivery.id, common);
      return { kind: 'retry' as const, attempts: cycle };
    });

    if (decision.kind === 'delivered') return { delivered: true, statusCode: outcome.statusCode };
    if (decision.kind === 'dead') {
      if (decision.disabled) await this.notifyAutoDisabled(decision.disabled);
      return { dead: true, errorClass: outcome.errorClass };
    }
    throw new RetryAfterError(
      retryDelayMs(decision.attempts, this.random),
      `attempt ${decision.attempts} failed (${outcome.errorClass ?? 'error'})`,
    );
  }

  private async cancel(tx: Transaction, delivery: WebhookDelivery, reason: string) {
    await updateDelivery(tx, delivery.organizationId, delivery.id, {
      status: 'cancelled',
      lastErrorClass: reason,
      finishedAt: this.now,
    });
  }

  // ---------------------------------------------------------------------------
  // Failure bookkeeping and automatic disablement (D6)
  // ---------------------------------------------------------------------------

  /**
   * A dead-lettered delivery counts as one failed delivery. Disables the endpoint (and audits it)
   * after 10 consecutive failed deliveries or 3 days without a success, whichever comes first.
   * Returns the endpoint when it was disabled, for the notification after commit.
   */
  async registerFailure(
    tx: Transaction,
    organizationId: string,
    endpointId: string,
    deliveryId: string | null,
  ): Promise<WebhookEndpoint | null> {
    const endpoint = await getEndpoint(tx, organizationId, endpointId, { forUpdate: true });
    if (!endpoint) return null;
    const failures = endpoint.consecutiveFailures + 1;
    const stale =
      (endpoint.lastSuccessAt ?? endpoint.createdAt).getTime() <
      this.now.getTime() - AUTO_DISABLE_AFTER_MS;
    const disable = endpoint.status === 'active' && (failures >= AUTO_DISABLE_FAILURES || stale);
    const updated = await updateEndpoint(tx, {
      organizationId,
      id: endpointId,
      bumpVersion: disable,
      changes: {
        consecutiveFailures: failures,
        lastFailureAt: this.now,
        ...(disable && {
          status: 'auto_disabled' as const,
          disabledAt: this.now,
          disabledReason:
            failures >= AUTO_DISABLE_FAILURES
              ? `${failures} consecutive failed deliveries`
              : 'No successful delivery for 3 days',
        }),
      },
      userId: null,
      now: this.now,
    });
    if (!disable || !updated) return null;
    await this.audit(
      tx,
      organizationId,
      'webhook_endpoint.auto_disabled',
      'webhook_endpoint',
      endpointId,
      {
        reason: updated.disabledReason,
        consecutiveFailures: failures,
        deliveryId,
      },
    );
    return updated;
  }

  /** Tells the people responsible (the integration's administrator and the endpoint's creator). */
  async notifyAutoDisabled(endpoint: WebhookEndpoint): Promise<void> {
    try {
      const recipients = await inTransaction(
        this.deps.db,
        { organizationId: endpoint.organizationId },
        async (tx) => {
          const integration = await getIntegration(
            tx,
            endpoint.organizationId,
            endpoint.integrationId,
          );
          const responsible = integration
            ? await findMembershipById(
                tx,
                endpoint.organizationId,
                integration.responsibleMembershipId,
              )
            : undefined;
          const ids = [endpoint.createdByUserId, responsible?.userId].filter(
            (id): id is string => !!id,
          );
          const profiles = await getUserProfiles(tx, [...new Set(ids)]);
          return [...profiles.values()].map((p) => p.email);
        },
      );
      for (const to of recipients) {
        await this.deps.emailProvider.send({
          to,
          template: 'webhook-endpoint-auto-disabled',
          subject: `Webhook endpoint "${endpoint.name}" was disabled`,
          text: `The webhook endpoint "${endpoint.name}" was disabled automatically (${endpoint.disabledReason ?? 'repeated failures'}). Events produced while it is disabled are not replayed: use the API to reconcile. Fix the endpoint, send a test ping and enable it again.`,
        });
      }
    } catch (error) {
      // A notification problem must never fail a delivery.
      this.deps.logger.warn({ err: error, endpointId: endpoint.id }, 'Webhook notification failed');
    }
  }

  // ---------------------------------------------------------------------------
  // Maintenance: stale endpoints, lost jobs, retention
  // ---------------------------------------------------------------------------

  /** Auto-disables active endpoints with failures and no success for 3 days (D6). */
  async autoDisableStale(): Promise<number> {
    let disabled = 0;
    const organizations = await inTransaction(this.deps.db, {}, (tx) =>
      organizationsWithWebhooks(tx),
    );
    const staleBefore = new Date(this.now.getTime() - AUTO_DISABLE_AFTER_MS);
    for (const organizationId of organizations) {
      const notify: WebhookEndpoint[] = [];
      await inTransaction(this.deps.db, { organizationId }, async (tx) => {
        for (const endpoint of await staleEndpoints(tx, organizationId, staleBefore)) {
          const updated = await updateEndpoint(tx, {
            organizationId,
            id: endpoint.id,
            changes: {
              status: 'auto_disabled',
              disabledAt: this.now,
              disabledReason: 'No successful delivery for 3 days',
            },
            userId: null,
            now: this.now,
          });
          if (!updated) continue;
          await this.audit(
            tx,
            organizationId,
            'webhook_endpoint.auto_disabled',
            'webhook_endpoint',
            endpoint.id,
            {
              reason: updated.disabledReason,
              consecutiveFailures: endpoint.consecutiveFailures,
            },
          );
          notify.push(updated);
          disabled += 1;
        }
      });
      for (const endpoint of notify) await this.notifyAutoDisabled(endpoint);
    }
    return disabled;
  }

  /** Pending deliveries whose job ended unsuccessfully can never run: dead-letter them. */
  async reconcileOrphans(): Promise<number> {
    let reconciled = 0;
    const organizations = await inTransaction(this.deps.db, {}, (tx) =>
      organizationsWithWebhooks(tx),
    );
    for (const organizationId of organizations) {
      await inTransaction(this.deps.db, { organizationId }, async (tx) => {
        for (const delivery of await orphanedDeliveries(tx, organizationId)) {
          await updateDelivery(tx, organizationId, delivery.id, {
            status: 'dead',
            lastErrorClass: 'internal',
            finishedAt: this.now,
          });
          await this.registerFailure(tx, organizationId, delivery.endpointId, delivery.id);
          reconciled += 1;
        }
      });
    }
    return reconciled;
  }

  /** Retention: finished delivery history and processed public outbox rows past their cutoffs. */
  async purge(): Promise<{ history: number; outbox: number }> {
    const historyCutoff = new Date(this.now.getTime() - this.settings.retentionMs);
    const outboxCutoff = new Date(this.now.getTime() - this.settings.outboxRetentionMs);
    const loop = async (run: (tx: Transaction) => Promise<number>) => {
      let total = 0;
      for (;;) {
        const n = await inTransaction(this.deps.db, {}, run);
        total += n;
        if (n < 1000) return total;
      }
    };
    return {
      history: await loop((tx) => purgeWebhookHistory(tx, historyCutoff, 1000)),
      outbox: await loop((tx) => purgePublicOutbox(tx, outboxCutoff, 1000)),
    };
  }

  /** One maintenance round (the server polls it; tests call it directly). */
  async runMaintenance() {
    return {
      orphans: await this.reconcileOrphans(),
      autoDisabled: await this.autoDisableStale(),
      purged: await this.purge(),
    };
  }
}
