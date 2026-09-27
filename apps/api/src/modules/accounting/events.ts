import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';
import { accountingEvents } from './schema.js';

export type AccountingEvent = typeof accountingEvents.$inferSelect;

/** Stable JSON (sorted keys) so equal payloads always hash equally. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function hashPayload(payload: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

export type ReceiveResult =
  | { outcome: 'created'; event: AccountingEvent }
  | { outcome: 'duplicate'; event: AccountingEvent }
  | { outcome: 'conflict'; event: AccountingEvent };

/**
 * Idempotent intake of an accounting event. The (organization, source module, event key)
 * triple is unique: a replay with the same payload returns the original event; a replay
 * with a different payload is a conflict and changes nothing.
 */
export async function receiveAccountingEvent(
  tx: Transaction,
  input: {
    organizationId: string;
    sourceModule: string;
    eventType: string;
    eventKey: string;
    payload: Record<string, unknown>;
    occurredAt: Date;
    now: Date;
  },
): Promise<ReceiveResult> {
  const payloadHash = hashPayload(input.payload);
  const [created] = await tx
    .insert(accountingEvents)
    .values({
      organizationId: input.organizationId,
      sourceModule: input.sourceModule,
      eventType: input.eventType,
      eventKey: input.eventKey,
      payload: input.payload,
      payloadHash,
      occurredAt: input.occurredAt,
      receivedAt: input.now,
    })
    .onConflictDoNothing({
      target: [
        accountingEvents.organizationId,
        accountingEvents.sourceModule,
        accountingEvents.eventKey,
      ],
    })
    .returning();
  if (created) return { outcome: 'created', event: created };

  const [existing] = await tx
    .select()
    .from(accountingEvents)
    .where(
      and(
        eq(accountingEvents.organizationId, input.organizationId),
        eq(accountingEvents.sourceModule, input.sourceModule),
        eq(accountingEvents.eventKey, input.eventKey),
      ),
    )
    .limit(1);
  if (!existing) throw new Error('Accounting event vanished during idempotent insert');
  const sameEvent = existing.payloadHash === payloadHash && existing.eventType === input.eventType;
  return { outcome: sameEvent ? 'duplicate' : 'conflict', event: existing };
}

export async function completeAccountingEvent(
  tx: Transaction,
  input: {
    organizationId: string;
    eventId: string;
    status: 'processed' | 'failed';
    journalId: string | null;
    error: string | null;
    now: Date;
  },
): Promise<void> {
  await tx
    .update(accountingEvents)
    .set({
      status: input.status,
      journalId: input.journalId,
      error: input.error?.slice(0, 2000) ?? null,
      processedAt: input.now,
    })
    .where(
      and(
        eq(accountingEvents.organizationId, input.organizationId),
        eq(accountingEvents.id, input.eventId),
      ),
    );
}
