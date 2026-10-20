import { randomUUID } from 'node:crypto';
import {
  AppError,
  ConflictError,
  NotFoundError,
  TooManyAttemptsError,
  ValidationError,
  type ValidationIssue,
} from '../domain/errors.js';
import type { Transaction } from '../database/client.js';
import { getIntegration } from '../modules/api-integrations/index.js';
import { recordAuditEvent, type EventOrigin } from '../modules/audit/index.js';
import { getSecurityPolicy } from '../modules/organizations/index.js';
import { DOMAIN_PUBLIC_EVENT_TYPES } from '../modules/public-events/index.js';
import {
  countLiveEndpoints,
  generateWebhookSecret,
  getDelivery,
  getEndpoint,
  insertAttempt,
  insertDelivery,
  insertEndpoint,
  latestPingSince,
  listAttempts,
  listDeliveries,
  listEndpoints,
  listSubscriptions,
  readPermissionOfEvent,
  replaceSubscriptions,
  updateDelivery,
  updateEndpoint,
  visibleDeliveryResourceTypes,
  WebhookDestinationError,
  type DeliveryStatus,
  type PayloadMode,
  type WebhookDelivery,
  type WebhookEndpoint,
  type WebhookSecretCipher,
  type WebhookTransport,
} from '../modules/webhooks/index.js';
import {
  hasPermission,
  requireRecentMfa,
  type AuthorizationContext,
  type Principal,
} from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import { effectiveIntegrationPermissions } from './integration-auth-service.js';
import { mfaRequirement } from './mfa-policy.js';
import { withOrganization } from './organization-service.js';
import type { WebhookDeliveryService } from './webhook-delivery-service.js';

/**
 * Webhook endpoint management by people (ADR 0011 sections 11.3–11.6, 18.8, 19.6). Creating or
 * changing an endpoint, rotating its secret, disabling/enabling, deleting and redelivering need
 * `webhooks.manage`, a recent password confirmation and, where the organization's MFA policy
 * applies to the actor, a recent second factor. Viewing endpoints and history needs
 * `webhooks.view`. The signing secret is shown ONCE (create, rotate) and never returned or logged.
 *
 * A subscription cannot exceed what the endpoint's integration may read, and the acting person
 * must hold the same read permission (section 19.6); fan-out and delivery re-check both.
 */

export const WEBHOOK_PERMISSIONS = { View: 'webhooks.view', Manage: 'webhooks.manage' } as const;
const RESOURCE = 'webhook_endpoint';
const SUBSCRIBABLE = DOMAIN_PUBLIC_EVENT_TYPES as readonly string[];

const versionConflict = () =>
  new ConflictError('VERSION_CONFLICT', 'The endpoint changed; reload it and try again.');

/** One ping per endpoint per 10 seconds (ADR 0011 sections 11.3 and 25.3; a fixed v1 value). */
export const PING_MIN_INTERVAL_MS = 10_000;

/**
 * How many whole seconds a ping must still wait, or null when it may be sent. `elapsedMs` is the
 * time since the endpoint's latest ping delivery was created. At exactly the interval a ping is
 * allowed. The wait is rounded up and clamped to 1..10, which also covers a latest ping dated in
 * the future (clock skew between instances).
 */
export function pingRetryAfterSeconds(elapsedMs: number): number | null {
  if (elapsedMs >= PING_MIN_INTERVAL_MS) return null;
  const seconds = Math.ceil((PING_MIN_INTERVAL_MS - elapsedMs) / 1000);
  return Math.min(PING_MIN_INTERVAL_MS / 1000, Math.max(1, seconds));
}
const invalidState = (message: string) => new ConflictError('INVALID_STATE_TRANSITION', message);

export interface EndpointInput {
  name: string;
  url: string;
  integrationId: string;
  eventTypes: string[];
  payloadMode?: PayloadMode | undefined;
}

export interface EndpointUpdate {
  version: number;
  name?: string | undefined;
  url?: string | undefined;
  eventTypes?: string[] | undefined;
  payloadMode?: PayloadMode | undefined;
}

export class WebhookEndpointService {
  constructor(
    private readonly deps: AppDependencies,
    private readonly transport: WebhookTransport,
    private readonly cipher: WebhookSecretCipher | null,
    private readonly deliveries: WebhookDeliveryService,
  ) {}

  private get now() {
    return this.deps.clock.now();
  }

  private requireCipher(): WebhookSecretCipher {
    if (!this.cipher) {
      throw new AppError('WEBHOOKS_NOT_CONFIGURED', 503, 'Webhook signing is not configured.');
    }
    return this.cipher;
  }

  private async stepUpWhenEnforced(
    tx: Transaction,
    principal: Principal,
    ctx: AuthorizationContext,
  ) {
    const policy = await getSecurityPolicy(tx, ctx.organizationId);
    if (mfaRequirement(ctx, policy).required) {
      await requireRecentMfa(tx, principal, this.now, this.deps.config.mfa.stepUpWindowMs);
    }
  }

  private manage<T>(
    principal: Principal,
    work: (tx: Transaction, ctx: AuthorizationContext) => Promise<T>,
    options: { sensitive: boolean } = { sensitive: true },
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: WEBHOOK_PERMISSIONS.Manage, sensitive: options.sensitive },
      async (tx, ctx) => {
        if (options.sensitive) await this.stepUpWhenEnforced(tx, principal, ctx);
        return work(tx, ctx);
      },
    );
  }

  private audit(
    tx: Transaction,
    ctx: AuthorizationContext,
    action: string,
    resourceType: string,
    resourceId: string,
    origin: EventOrigin,
    metadata: Record<string, unknown>,
  ) {
    return recordAuditEvent(tx, {
      occurredAt: this.now,
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action,
      resourceType,
      resourceId,
      metadata,
      origin,
    });
  }

  // ---------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------

  private view(endpoint: WebhookEndpoint, eventTypes: string[]) {
    return {
      id: endpoint.id,
      name: endpoint.name,
      url: endpoint.url,
      integrationId: endpoint.integrationId,
      status: endpoint.status,
      apiVersion: endpoint.apiVersion,
      payloadMode: endpoint.payloadMode,
      eventTypes,
      consecutiveFailures: endpoint.consecutiveFailures,
      lastSuccessAt: endpoint.lastSuccessAt?.toISOString() ?? null,
      lastFailureAt: endpoint.lastFailureAt?.toISOString() ?? null,
      disabledAt: endpoint.disabledAt?.toISOString() ?? null,
      disabledReason: endpoint.disabledReason,
      pingVerifiedAt: endpoint.pingVerifiedAt?.toISOString() ?? null,
      // Whether the previous secret still signs deliveries; never the secrets themselves.
      secretOverlapUntil:
        endpoint.prevSecret && endpoint.prevSecret.expiresAt > this.now
          ? endpoint.prevSecret.expiresAt.toISOString()
          : null,
      version: endpoint.version,
      createdAt: endpoint.createdAt.toISOString(),
      updatedAt: endpoint.updatedAt.toISOString(),
    };
  }

  private deliveryView(d: WebhookDelivery) {
    return {
      id: d.id,
      endpointId: d.endpointId,
      eventId: d.eventId,
      eventType: d.eventType,
      resource: { type: d.resourceType, id: d.resourceId },
      status: d.status,
      attemptsMade: d.attemptsMade,
      redeliveryCount: d.redeliveryCount,
      lastStatusCode: d.lastStatusCode,
      lastErrorClass: d.lastErrorClass,
      createdAt: d.createdAt.toISOString(),
      finishedAt: d.finishedAt?.toISOString() ?? null,
    };
  }

  /** The event catalog and whether each type can be subscribed to with the current scope catalog. */
  eventCatalog(principal: Principal) {
    return withOrganization(
      this.deps,
      principal,
      { permission: WEBHOOK_PERMISSIONS.View },
      async () =>
        SUBSCRIBABLE.map((type) => ({
          type,
          subscribable: readPermissionOfEvent(type) !== null,
          requiredReadPermission: readPermissionOfEvent(type),
        })),
    );
  }

  list(principal: Principal) {
    return withOrganization(
      this.deps,
      principal,
      { permission: WEBHOOK_PERMISSIONS.View },
      async (tx, ctx) => {
        const endpoints = await listEndpoints(tx, ctx.organizationId);
        const subs = await listSubscriptions(
          tx,
          ctx.organizationId,
          endpoints.map((e) => e.id),
        );
        return endpoints.map((e) => this.view(e, subs.get(e.id) ?? []));
      },
    );
  }

  get(principal: Principal, id: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: WEBHOOK_PERMISSIONS.View },
      async (tx, ctx) => this.detail(tx, ctx.organizationId, id),
    );
  }

  private async detail(tx: Transaction, organizationId: string, id: string) {
    const endpoint = await getEndpoint(tx, organizationId, id);
    if (!endpoint) throw new NotFoundError('Webhook endpoint not found.');
    const subs = await listSubscriptions(tx, organizationId, [id]);
    return this.view(endpoint, subs.get(id) ?? []);
  }

  // ---------------------------------------------------------------------------
  // Validation shared by create and update
  // ---------------------------------------------------------------------------

  /** Destination rules (syntax and every resolved address), as validation issues. */
  private async destinationIssues(url: string): Promise<ValidationIssue[]> {
    try {
      await this.transport.checkDestination(url);
      return [];
    } catch (error) {
      if (error instanceof WebhookDestinationError) {
        return [{ path: 'url', message: error.message }];
      }
      throw error;
    }
  }

  /**
   * A subscription cannot exceed the integration's current readable resources, and the person
   * must hold the same read permission (section 19.6). Types without any public read scope in v1
   * cannot be subscribed to yet.
   */
  private async subscriptionIssues(
    tx: Transaction,
    ctx: AuthorizationContext,
    integrationId: string,
    eventTypes: readonly string[],
  ): Promise<ValidationIssue[]> {
    const issues: ValidationIssue[] = [];
    if (eventTypes.length === 0) {
      return [{ path: 'eventTypes', message: 'Subscribe to at least one event type.' }];
    }
    const permissions = await effectiveIntegrationPermissions(
      tx,
      ctx.organizationId,
      integrationId,
    );
    for (const type of new Set(eventTypes)) {
      if (!SUBSCRIBABLE.includes(type)) {
        issues.push({ path: 'eventTypes', message: `${type} is not an event type.` });
        continue;
      }
      const required = readPermissionOfEvent(type);
      if (!required) {
        issues.push({
          path: 'eventTypes',
          message: `${type} cannot be subscribed to yet: no API scope grants read access to that resource.`,
        });
      } else if (!permissions.has(required)) {
        issues.push({
          path: 'eventTypes',
          message: `${type} needs read access that the integration does not have.`,
        });
      } else if (!hasPermission(ctx, required)) {
        issues.push({
          path: 'eventTypes',
          message: `You cannot subscribe to ${type}: you do not have access to that resource.`,
        });
      }
    }
    return issues;
  }

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------

  create(principal: Principal, input: EndpointInput, origin: EventOrigin) {
    return this.manage(principal, async (tx, ctx) => {
      const cipher = this.requireCipher();
      const issues = [...(await this.destinationIssues(input.url))];
      const integration = await getIntegration(tx, ctx.organizationId, input.integrationId);
      if (!integration || integration.status !== 'active') {
        issues.push({ path: 'integrationId', message: 'Choose an active integration.' });
      } else {
        issues.push(
          ...(await this.subscriptionIssues(tx, ctx, input.integrationId, input.eventTypes)),
        );
      }
      if (issues.length) throw new ValidationError(issues);
      if ((await countLiveEndpoints(tx, ctx.organizationId)) >= 10) {
        throw new ConflictError(
          'CONFLICT',
          'An organization can have at most 10 webhook endpoints.',
        );
      }
      const id = randomUUID();
      const secret = generateWebhookSecret();
      const created = await insertEndpoint(tx, {
        id,
        organizationId: ctx.organizationId,
        integrationId: input.integrationId,
        name: input.name.trim(),
        url: input.url,
        payloadMode: input.payloadMode ?? 'thin',
        secret: cipher.seal(secret, id, 1, 'current'),
        userId: ctx.userId,
        now: this.now,
      });
      const eventTypes = [...new Set(input.eventTypes)].sort();
      await replaceSubscriptions(tx, ctx.organizationId, id, eventTypes, this.now);
      await this.audit(tx, ctx, 'webhook_endpoint.created', RESOURCE, id, origin, {
        name: created.name,
        url: created.url,
        integrationId: created.integrationId,
        payloadMode: created.payloadMode,
        eventTypes,
      });
      // The signing secret is returned exactly once.
      return { ...this.view(created, eventTypes), secret };
    });
  }

  update(principal: Principal, id: string, input: EndpointUpdate, origin: EventOrigin) {
    return this.manage(principal, async (tx, ctx) => {
      const endpoint = await getEndpoint(tx, ctx.organizationId, id, { forUpdate: true });
      if (!endpoint) throw new NotFoundError('Webhook endpoint not found.');
      if (endpoint.version !== input.version) throw versionConflict();
      const issues: ValidationIssue[] = [];
      const urlChanged = input.url !== undefined && input.url !== endpoint.url;
      if (urlChanged) issues.push(...(await this.destinationIssues(input.url!)));
      if (input.eventTypes) {
        issues.push(
          ...(await this.subscriptionIssues(tx, ctx, endpoint.integrationId, input.eventTypes)),
        );
      }
      if (issues.length) throw new ValidationError(issues);
      const before = (await listSubscriptions(tx, ctx.organizationId, [id])).get(id) ?? [];
      const eventTypes = input.eventTypes ? [...new Set(input.eventTypes)].sort() : before;
      const saved = await updateEndpoint(tx, {
        organizationId: ctx.organizationId,
        id,
        expectedVersion: input.version,
        changes: {
          ...(input.name !== undefined && { name: input.name.trim() }),
          ...(input.url !== undefined && { url: input.url }),
          ...(input.payloadMode !== undefined && { payloadMode: input.payloadMode }),
          // A new destination must prove itself again before a disabled endpoint can be enabled.
          ...(urlChanged && { pingVerifiedAt: null }),
        },
        userId: ctx.userId,
        now: this.now,
      });
      if (!saved) throw versionConflict();
      if (input.eventTypes) {
        await replaceSubscriptions(tx, ctx.organizationId, id, eventTypes, this.now);
      }
      await this.audit(tx, ctx, 'webhook_endpoint.updated', RESOURCE, id, origin, {
        version: saved.version,
        changedFields: [
          ...(input.name !== undefined && input.name.trim() !== endpoint.name ? ['name'] : []),
          ...(urlChanged ? ['url'] : []),
          ...(input.payloadMode !== undefined && input.payloadMode !== endpoint.payloadMode
            ? ['payloadMode']
            : []),
          ...(input.eventTypes && JSON.stringify(eventTypes) !== JSON.stringify(before)
            ? ['eventTypes']
            : []),
        ],
        eventTypes,
      });
      return this.view(saved, eventTypes);
    });
  }

  remove(principal: Principal, id: string, input: { version: number }, origin: EventOrigin) {
    return this.manage(principal, async (tx, ctx) => {
      const endpoint = await getEndpoint(tx, ctx.organizationId, id, { forUpdate: true });
      if (!endpoint) throw new NotFoundError('Webhook endpoint not found.');
      if (endpoint.version !== input.version) throw versionConflict();
      await updateEndpoint(tx, {
        organizationId: ctx.organizationId,
        id,
        expectedVersion: input.version,
        changes: { deletedAt: this.now, deletedByUserId: ctx.userId },
        userId: ctx.userId,
        now: this.now,
      });
      // Its pending deliveries are cancelled when their jobs run (the endpoint is gone).
      await this.audit(tx, ctx, 'webhook_endpoint.deleted', RESOURCE, id, origin, {
        name: endpoint.name,
      });
      return { id, deleted: true };
    });
  }

  rotateSecret(principal: Principal, id: string, input: { version: number }, origin: EventOrigin) {
    return this.manage(principal, async (tx, ctx) => {
      const cipher = this.requireCipher();
      const endpoint = await getEndpoint(tx, ctx.organizationId, id, { forUpdate: true });
      if (!endpoint) throw new NotFoundError('Webhook endpoint not found.');
      if (endpoint.version !== input.version) throw versionConflict();
      const version = endpoint.secretVersion + 1;
      const previous = cipher.open(endpoint.secret, id, endpoint.secretVersion, 'current');
      const secret = generateWebhookSecret();
      const overlapUntil = new Date(this.now.getTime() + this.deps.config.webhooks.secretOverlapMs);
      const saved = await updateEndpoint(tx, {
        organizationId: ctx.organizationId,
        id,
        expectedVersion: input.version,
        changes: {
          secretVersion: version,
          secret: cipher.seal(secret, id, version, 'current'),
          prevSecret: {
            ...cipher.seal(previous, id, version, 'previous'),
            expiresAt: overlapUntil,
          },
        },
        userId: ctx.userId,
        now: this.now,
      });
      if (!saved) throw versionConflict();
      await this.audit(tx, ctx, 'webhook_endpoint.secret_rotated', RESOURCE, id, origin, {
        rotation: version,
        overlapUntil: overlapUntil.toISOString(),
      });
      const eventTypes = (await listSubscriptions(tx, ctx.organizationId, [id])).get(id) ?? [];
      return { ...this.view(saved, eventTypes), secret };
    });
  }

  disable(
    principal: Principal,
    id: string,
    input: { version: number; reason?: string | undefined },
    origin: EventOrigin,
  ) {
    return this.manage(principal, async (tx, ctx) => {
      const endpoint = await getEndpoint(tx, ctx.organizationId, id, { forUpdate: true });
      if (!endpoint) throw new NotFoundError('Webhook endpoint not found.');
      if (endpoint.version !== input.version) throw versionConflict();
      if (endpoint.status !== 'active') throw invalidState('The endpoint is already disabled.');
      const saved = await updateEndpoint(tx, {
        organizationId: ctx.organizationId,
        id,
        expectedVersion: input.version,
        changes: {
          status: 'disabled',
          disabledAt: this.now,
          disabledByUserId: ctx.userId,
          disabledReason: input.reason?.trim() || 'Disabled manually',
          pingVerifiedAt: null,
        },
        userId: ctx.userId,
        now: this.now,
      });
      if (!saved) throw versionConflict();
      await this.audit(tx, ctx, 'webhook_endpoint.disabled', RESOURCE, id, origin, {
        reason: saved.disabledReason,
      });
      return this.detail(tx, ctx.organizationId, id);
    });
  }

  /**
   * Re-enabling needs `webhooks.manage` + re-authentication AND a successful ping since the
   * endpoint was disabled (D6). Events produced meanwhile are not replayed.
   */
  enable(principal: Principal, id: string, input: { version: number }, origin: EventOrigin) {
    return this.manage(principal, async (tx, ctx) => {
      const endpoint = await getEndpoint(tx, ctx.organizationId, id, { forUpdate: true });
      if (!endpoint) throw new NotFoundError('Webhook endpoint not found.');
      if (endpoint.version !== input.version) throw versionConflict();
      if (endpoint.status === 'active') throw invalidState('The endpoint is already active.');
      if (
        !endpoint.pingVerifiedAt ||
        !endpoint.disabledAt ||
        endpoint.pingVerifiedAt.getTime() < endpoint.disabledAt.getTime()
      ) {
        throw invalidState('Send a successful test ping to the endpoint before enabling it.');
      }
      const issues = await this.destinationIssues(endpoint.url);
      if (issues.length) throw new ValidationError(issues);
      const saved = await updateEndpoint(tx, {
        organizationId: ctx.organizationId,
        id,
        expectedVersion: input.version,
        changes: {
          status: 'active',
          disabledAt: null,
          disabledByUserId: null,
          disabledReason: null,
          consecutiveFailures: 0,
          // Returning to `active` restarts the no-success window (CR-0011-S6-01, migration 0059).
          enabledAt: this.now,
        },
        userId: ctx.userId,
        now: this.now,
      });
      if (!saved) throw versionConflict();
      await this.audit(tx, ctx, 'webhook_endpoint.enabled', RESOURCE, id, origin, {
        previousStatus: endpoint.status,
      });
      return this.detail(tx, ctx.organizationId, id);
    });
  }

  /**
   * Sends one signed `webhook.ping` and reports the result. It works in any status (a disabled
   * endpoint must be pingable before it is enabled). The request is made with no transaction
   * open; a successful ping is what allows `enable`.
   */
  async ping(principal: Principal, id: string, origin: EventOrigin) {
    const prepared = await this.manage(
      principal,
      async (tx, ctx) => {
        // The endpoint row lock serializes every ping of this endpoint: a concurrent request waits
        // here until this transaction commits (its delivery row exists) or rolls back, and then
        // sees that delivery. The lock is held only for this short transaction, never during the
        // network request, and the transaction takes no other lock that a delivery job could hold.
        const endpoint = await getEndpoint(tx, ctx.organizationId, id, { forUpdate: true });
        if (!endpoint) throw new NotFoundError('Webhook endpoint not found.');
        const requestedAt = this.now;
        const latest = await latestPingSince(
          tx,
          ctx.organizationId,
          id,
          new Date(requestedAt.getTime() - PING_MIN_INTERVAL_MS),
        );
        if (latest) {
          // Refused before anything is written: no delivery row, no audit event.
          const wait = pingRetryAfterSeconds(requestedAt.getTime() - latest.getTime());
          if (wait !== null) throw new TooManyAttemptsError(wait);
        }
        const secrets = this.deliveries.secretsOf(endpoint);
        const eventId = `evt_${randomUUID()}`;
        const payload = {
          id: eventId,
          type: 'webhook.ping',
          api_version: 'v1',
          occurred_at: this.now.toISOString(),
          organization_id: ctx.organizationId,
          resource: { type: 'webhook_endpoint', id },
          data: { object_type: 'webhook_endpoint', object_id: id, url: null },
        };
        const delivery = await insertDelivery(tx, {
          organizationId: ctx.organizationId,
          endpointId: id,
          eventId,
          eventType: 'webhook.ping',
          outboxEventId: null,
          resourceType: 'webhook_endpoint',
          resourceId: id,
          payload,
          now: this.now,
        });
        return { endpoint, secrets, delivery: delivery!, body: JSON.stringify(payload), ctx };
      },
      { sensitive: false },
    );
    const startedAt = this.now;
    const outcome = await this.deliveries.attempt({
      url: prepared.endpoint.url,
      secrets: prepared.secrets,
      deliveryId: prepared.delivery.id,
      eventType: 'webhook.ping',
      body: prepared.body,
    });
    await this.manage(
      principal,
      async (tx, ctx) => {
        await insertAttempt(tx, {
          organizationId: ctx.organizationId,
          deliveryId: prepared.delivery.id,
          attemptNo: 1,
          startedAt,
          durationMs: outcome.durationMs,
          statusCode: outcome.statusCode,
          errorClass: outcome.errorClass,
          responseExcerpt: outcome.excerpt,
        });
        await updateDelivery(tx, ctx.organizationId, prepared.delivery.id, {
          status: outcome.success ? 'succeeded' : 'dead',
          attemptsMade: 1,
          cycleAttempts: 1,
          lastStatusCode: outcome.statusCode,
          lastErrorClass: outcome.errorClass,
          finishedAt: this.now,
        });
        // A ping never counts toward automatic disablement; success is what enabling needs.
        if (outcome.success) {
          await updateEndpoint(tx, {
            organizationId: ctx.organizationId,
            id,
            changes: { pingVerifiedAt: this.now },
            bumpVersion: false,
            userId: ctx.userId,
            now: this.now,
          });
        }
        await this.audit(tx, ctx, 'webhook_endpoint.pinged', RESOURCE, id, origin, {
          deliveryId: prepared.delivery.id,
          success: outcome.success,
          statusCode: outcome.statusCode,
          errorClass: outcome.errorClass,
        });
      },
      { sensitive: false },
    );
    return {
      deliveryId: prepared.delivery.id,
      success: outcome.success,
      statusCode: outcome.statusCode,
      errorClass: outcome.errorClass,
      durationMs: outcome.durationMs,
    };
  }

  // ---------------------------------------------------------------------------
  // Delivery history and redelivery
  // ---------------------------------------------------------------------------

  /**
   * The delivery families this person may see (ADR 0011 section 25.2), from their CURRENT
   * permissions, evaluated for every request. Owner and Administrator hold every view permission.
   */
  private visibleTypes(ctx: AuthorizationContext): string[] {
    return visibleDeliveryResourceTypes((permission) => hasPermission(ctx, permission));
  }

  /**
   * Delivery history. Rows of families the person may not read are excluded by the query itself,
   * before the ordering and the limit, so the page is never shortened and nothing about them leaks.
   */
  listDeliveries(
    principal: Principal,
    query: { endpointId?: string | undefined; status?: DeliveryStatus | undefined; limit: number },
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: WEBHOOK_PERMISSIONS.View },
      async (tx, ctx) =>
        (
          await listDeliveries(tx, {
            organizationId: ctx.organizationId,
            ...(query.endpointId && { endpointId: query.endpointId }),
            ...(query.status && { status: query.status }),
            limit: query.limit,
            visibleResourceTypes: this.visibleTypes(ctx),
          })
        ).map((d) => this.deliveryView(d)),
    );
  }

  /**
   * One delivery with its attempts. A delivery of a family the person may not read answers 404,
   * exactly like a missing one. The stored response excerpt is returned only to holders of
   * `webhooks.manage`; everyone else receives `responseExcerpt: null` (section 25.2).
   */
  getDelivery(principal: Principal, id: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: WEBHOOK_PERMISSIONS.View },
      async (tx, ctx) => {
        const delivery = await getDelivery(tx, ctx.organizationId, id, {
          visibleResourceTypes: this.visibleTypes(ctx),
        });
        if (!delivery) throw new NotFoundError('Delivery not found.');
        const attempts = await listAttempts(tx, ctx.organizationId, id);
        const mayReadExcerpts = hasPermission(ctx, WEBHOOK_PERMISSIONS.Manage);
        return {
          ...this.deliveryView(delivery),
          attempts: attempts.map((a) => ({
            attemptNo: a.attemptNo,
            startedAt: a.startedAt.toISOString(),
            durationMs: a.durationMs,
            statusCode: a.statusCode,
            errorClass: a.errorClass,
            responseExcerpt: mayReadExcerpts ? a.responseExcerpt : null,
          })),
        };
      },
    );
  }

  /**
   * Manual redelivery of one delivery (including a dead one): a fresh retry cycle of the SAME
   * delivery and event id. The scope and destination are re-checked when it runs. `webhooks.manage`
   * is checked first (403); a delivery of a family the manager may not read then answers 404, like a
   * missing one, re-checked here against the current permissions.
   */
  redeliver(principal: Principal, id: string, origin: EventOrigin) {
    return this.manage(principal, async (tx, ctx) => {
      const delivery = await getDelivery(tx, ctx.organizationId, id, {
        forUpdate: true,
        visibleResourceTypes: this.visibleTypes(ctx),
      });
      if (!delivery) throw new NotFoundError('Delivery not found.');
      if (delivery.status === 'pending') throw invalidState('The delivery is still in progress.');
      if (delivery.eventType === 'webhook.ping') {
        throw invalidState('A test ping is sent again with the ping action.');
      }
      const endpoint = await getEndpoint(tx, ctx.organizationId, delivery.endpointId);
      if (!endpoint || endpoint.status !== 'active') {
        throw invalidState('The endpoint is not active.');
      }
      const updated = await updateDelivery(tx, ctx.organizationId, id, {
        status: 'pending',
        cycleAttempts: 0,
        redeliveryCount: delivery.redeliveryCount + 1,
        finishedAt: null,
        lastErrorClass: null,
      });
      await this.deliveries.enqueue(tx, updated!);
      await this.audit(tx, ctx, 'webhook_delivery.redelivered', 'webhook_delivery', id, origin, {
        endpointId: delivery.endpointId,
        eventType: delivery.eventType,
        previousStatus: delivery.status,
        redelivery: updated!.redeliveryCount,
      });
      return this.deliveryView(updated!);
    });
  }
}
