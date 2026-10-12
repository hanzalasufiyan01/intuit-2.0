import { randomUUID } from 'node:crypto';
import type { Transaction } from '../../database/client.js';
import { enqueueOutboxEvent } from '../outbox/index.js';
import {
  DOMAIN_PUBLIC_EVENT_TYPES,
  PUBLIC_API_VERSION,
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
 * What the outbox row carries (ADR 0011 section 18.9): identity and reference only. No snapshot,
 * no changed fields, no amounts, no journal or accounting data: a later fan-out builds the public
 * DTO from the current resource, and consumers reconcile by retrieving it.
 */
export interface PublicEventPayload {
  event_id: string;
  type: DomainPublicEventType;
  api_version: typeof PUBLIC_API_VERSION;
  occurred_at: string;
  organization_id: string;
  resource: { type: PublicResourceType; id: string; version?: number };
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
  const payload: PublicEventPayload = {
    event_id: eventId,
    type: event.type,
    api_version: PUBLIC_API_VERSION,
    occurred_at: occurredAt.toISOString(),
    organization_id: event.organizationId,
    resource: {
      type: resourceType,
      id: event.resourceId,
      ...(event.version !== undefined && { version: event.version }),
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
