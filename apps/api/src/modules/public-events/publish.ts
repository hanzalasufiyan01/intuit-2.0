import { randomUUID } from 'node:crypto';
import type { Transaction } from '../../database/client.js';
import { enqueueOutboxEvent } from '../outbox/index.js';
import {
  DOMAIN_PUBLIC_EVENT_TYPES,
  PUBLIC_API_VERSION,
  PUBLIC_READ_PATHS,
  publicOutboxType,
  type DomainPublicEventType,
  type PublicResourceType,
} from './catalog.js';

export interface PublicEventInput {
  type: DomainPublicEventType;
  organizationId: string;
  resourceId: string;
  /** The resource's own version after the change (omitted only for resources that have none). */
  version?: number | undefined;
}

/**
 * The frozen public event envelope (ADR 0011 section 19.1), stored as the outbox payload:
 * `id`, `type`, `api_version`, `occurred_at`, `organization_id`, `resource` and `data`. `data` is
 * the default **thin** form `{ object_type, object_id, url }` and nothing else; a later fan-out
 * only replaces it for endpoints that opted into the `full` mode (the versioned public DTO).
 * Identity and reference only: no snapshot, changed fields, amounts, or journal, ledger,
 * tax-snapshot or other accounting data. Consumers reconcile by retrieving the resource.
 */
export interface PublicEventPayload {
  /** The immutable, unique event id (never the resource id; the consumer's de-duplication key). */
  id: string;
  type: DomainPublicEventType;
  api_version: typeof PUBLIC_API_VERSION;
  occurred_at: string;
  organization_id: string;
  resource: { type: PublicResourceType; id: string; version?: number };
  data: { object_type: PublicResourceType; object_id: string; url: string | null };
}

const KNOWN = new Set<string>(DOMAIN_PUBLIC_EVENT_TYPES);

/**
 * Inserts the public event into the caller's transaction (transactional outbox): it exists if and
 * only if the business change commits, and it is never delivered from here — delivery is a later,
 * asynchronous step. `occurredAt` is the instant of the originating change.
 */
export async function publishPublicEvent(
  tx: Transaction,
  event: PublicEventInput,
  occurredAt: Date,
): Promise<string> {
  if (!KNOWN.has(event.type)) throw new Error(`Unknown public event type: ${event.type}`);
  const resourceType = event.type.slice(0, event.type.indexOf('.')) as PublicResourceType;
  const eventId = `evt_${randomUUID()}`;
  const readPath = PUBLIC_READ_PATHS[resourceType];
  const payload: PublicEventPayload = {
    id: eventId,
    type: event.type,
    api_version: PUBLIC_API_VERSION,
    occurred_at: occurredAt.toISOString(),
    organization_id: event.organizationId,
    resource: {
      type: resourceType,
      id: event.resourceId,
      ...(event.version !== undefined && { version: event.version }),
    },
    data: {
      object_type: resourceType,
      object_id: event.resourceId,
      url: readPath ? `${readPath}/${event.resourceId}` : null,
    },
  };
  await enqueueOutboxEvent(
    tx,
    {
      eventType: publicOutboxType(event.type),
      aggregateType: resourceType,
      aggregateId: event.resourceId,
      organizationId: event.organizationId,
      payload: payload as unknown as Record<string, unknown>,
    },
    occurredAt,
  );
  return eventId;
}
