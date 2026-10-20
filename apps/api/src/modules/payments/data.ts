import { and, desc, eq, sql } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';
import {
  paymentEvents,
  paymentGatewaySettings,
  paymentIntents,
  type IntentStatus,
} from './schema.js';

export type GatewaySettings = typeof paymentGatewaySettings.$inferSelect;
export type PaymentIntent = typeof paymentIntents.$inferSelect;
export type PaymentEvent = typeof paymentEvents.$inferSelect;

export async function getGatewaySettings(tx: Transaction, organizationId: string) {
  const [row] = await tx
    .select()
    .from(paymentGatewaySettings)
    .where(eq(paymentGatewaySettings.organizationId, organizationId));
  return row;
}

export async function saveGatewaySettings(
  tx: Transaction,
  input: {
    organizationId: string;
    version: number;
    values: Omit<typeof paymentGatewaySettings.$inferInsert, 'organizationId' | 'version'>;
  },
) {
  if (input.version === 0) {
    const [row] = await tx
      .insert(paymentGatewaySettings)
      .values({ organizationId: input.organizationId, ...input.values })
      .onConflictDoNothing()
      .returning();
    return row;
  }
  const [row] = await tx
    .update(paymentGatewaySettings)
    .set({ ...input.values, version: sql`${paymentGatewaySettings.version} + 1` })
    .where(
      and(
        eq(paymentGatewaySettings.organizationId, input.organizationId),
        eq(paymentGatewaySettings.version, input.version),
      ),
    )
    .returning();
  return row;
}

export async function insertIntent(tx: Transaction, values: typeof paymentIntents.$inferInsert) {
  const [row] = await tx.insert(paymentIntents).values(values).returning();
  return row!;
}

export async function getIntent(
  tx: Transaction,
  organizationId: string,
  id: string,
  options: { forUpdate?: boolean } = {},
) {
  const query = tx
    .select()
    .from(paymentIntents)
    .where(and(eq(paymentIntents.organizationId, organizationId), eq(paymentIntents.id, id)));
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row;
}

export async function listIntents(
  tx: Transaction,
  organizationId: string,
  filter: { invoiceId?: string | undefined; status?: IntentStatus | undefined; limit: number },
) {
  const conditions = [eq(paymentIntents.organizationId, organizationId)];
  if (filter.invoiceId) conditions.push(eq(paymentIntents.invoiceId, filter.invoiceId));
  if (filter.status) conditions.push(eq(paymentIntents.status, filter.status));
  return tx
    .select()
    .from(paymentIntents)
    .where(and(...conditions))
    .orderBy(desc(paymentIntents.createdAt), desc(paymentIntents.id))
    .limit(filter.limit);
}

/** The open (CREATED or PENDING) attempt of an invoice, if any, locked. */
export async function getOpenIntentForInvoice(
  tx: Transaction,
  organizationId: string,
  invoiceId: string,
) {
  const [row] = await tx
    .select()
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.organizationId, organizationId),
        eq(paymentIntents.invoiceId, invoiceId),
        sql`${paymentIntents.status} IN ('CREATED', 'PENDING')`,
      ),
    )
    .for('update');
  return row;
}

export async function updateIntent(
  tx: Transaction,
  organizationId: string,
  id: string,
  set: Partial<
    Pick<
      PaymentIntent,
      | 'status'
      | 'providerRef'
      | 'checkoutUrl'
      | 'failureCode'
      | 'receiptId'
      | 'completedAt'
      | 'updatedAt'
    >
  >,
) {
  const [row] = await tx
    .update(paymentIntents)
    .set({ ...set, version: sql`${paymentIntents.version} + 1` })
    .where(and(eq(paymentIntents.organizationId, organizationId), eq(paymentIntents.id, id)))
    .returning();
  return row!;
}

/** Records a provider event once. Returns false when the (provider, event id) was seen before. */
export async function insertPaymentEvent(
  tx: Transaction,
  values: typeof paymentEvents.$inferInsert,
) {
  const rows = await tx
    .insert(paymentEvents)
    .values(values)
    .onConflictDoNothing()
    .returning({ id: paymentEvents.id });
  return rows.length > 0;
}

export async function findPaymentEvent(tx: Transaction, provider: string, eventId: string) {
  const [row] = await tx
    .select({ outcome: paymentEvents.outcome })
    .from(paymentEvents)
    .where(and(eq(paymentEvents.provider, provider), eq(paymentEvents.providerEventId, eventId)));
  return row;
}

export async function listIntentEvents(tx: Transaction, organizationId: string, intentId: string) {
  return tx
    .select()
    .from(paymentEvents)
    .where(
      and(eq(paymentEvents.organizationId, organizationId), eq(paymentEvents.intentId, intentId)),
    )
    .orderBy(paymentEvents.receivedAt, paymentEvents.id);
}

/** Resolves a provider reference to its tenant and intent (narrow SECURITY DEFINER function). */
export async function lookupIntentByProviderRef(tx: Transaction, provider: string, ref: string) {
  const result = await tx.execute<{ organization_id: string; intent_id: string }>(
    sql`SELECT organization_id, intent_id FROM app_payment_intent_lookup(${provider}, ${ref})`,
  );
  const row = result.rows[0];
  return row ? { organizationId: row.organization_id, intentId: row.intent_id } : null;
}

export async function staleIntents(tx: Transaction, olderThan: Date, max: number) {
  const result = await tx.execute<{ organization_id: string; intent_id: string }>(
    sql`SELECT organization_id, intent_id FROM app_stale_payment_intents(${olderThan.toISOString()}::timestamptz, ${max})`,
  );
  return result.rows.map((r) => ({ organizationId: r.organization_id, intentId: r.intent_id }));
}
