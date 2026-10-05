import { and, asc, desc, eq, sql, type SQL } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';
import type { Bill } from './bills.js';
import type { Payment } from './payments.js';
import { purchasesBills, purchasesPaymentBatches, purchasesPayments } from './schema.js';

/** Payment batch data access (Phase 4B-4; ADR 0004 P4-32, P4-50). Rules live in the services. */

export type PaymentBatch = typeof purchasesPaymentBatches.$inferSelect;
export type NewPaymentBatch = typeof purchasesPaymentBatches.$inferInsert;

export async function insertPaymentBatch(
  tx: Transaction,
  values: NewPaymentBatch,
): Promise<PaymentBatch> {
  const [row] = await tx.insert(purchasesPaymentBatches).values(values).returning();
  return row!;
}

export async function getPaymentBatch(
  tx: Transaction,
  organizationId: string,
  id: string,
): Promise<PaymentBatch | undefined> {
  const [row] = await tx
    .select()
    .from(purchasesPaymentBatches)
    .where(
      and(
        eq(purchasesPaymentBatches.organizationId, organizationId),
        eq(purchasesPaymentBatches.id, id),
      ),
    );
  return row;
}

/** Newest first: keyset on (payment_date DESC, created_at DESC, id DESC). */
export async function listPaymentBatches(
  tx: Transaction,
  query: { organizationId: string; limit: number; after: { date: string; id: string } | null },
) {
  const conditions: (SQL | undefined)[] = [
    eq(purchasesPaymentBatches.organizationId, query.organizationId),
  ];
  if (query.after) {
    conditions.push(
      sql`(${purchasesPaymentBatches.paymentDate}, ${purchasesPaymentBatches.id}) < (${query.after.date}::date, ${query.after.id}::uuid)`,
    );
  }
  const rows = await tx
    .select()
    .from(purchasesPaymentBatches)
    .where(and(...conditions))
    .orderBy(desc(purchasesPaymentBatches.paymentDate), desc(purchasesPaymentBatches.id))
    .limit(query.limit + 1);
  return { items: rows.slice(0, query.limit), hasMore: rows.length > query.limit };
}

/** The payments recorded by a batch, in their numbering order. */
export async function listBatchPayments(
  tx: Transaction,
  organizationId: string,
  batchId: string,
): Promise<Payment[]> {
  return tx
    .select()
    .from(purchasesPayments)
    .where(
      and(
        eq(purchasesPayments.organizationId, organizationId),
        eq(purchasesPayments.paymentBatchId, batchId),
      ),
    )
    .orderBy(asc(purchasesPayments.number), asc(purchasesPayments.id));
}

/**
 * Posted bills with an amount due across vendors (Pay bills), earliest due first. Optional
 * filters: vendor, currency, due on or before a date.
 */
export async function listPayableBills(
  tx: Transaction,
  query: {
    organizationId: string;
    vendorId: string | null;
    currencyCode: string | null;
    dueBefore: string | null;
    limit: number;
  },
): Promise<Bill[]> {
  const conditions: (SQL | undefined)[] = [
    eq(purchasesBills.organizationId, query.organizationId),
    eq(purchasesBills.status, 'POSTED'),
    sql`${purchasesBills.amountDue} > 0`,
  ];
  if (query.vendorId) conditions.push(eq(purchasesBills.vendorId, query.vendorId));
  if (query.currencyCode) conditions.push(eq(purchasesBills.currencyCode, query.currencyCode));
  if (query.dueBefore) conditions.push(sql`${purchasesBills.dueDate} <= ${query.dueBefore}::date`);
  return tx
    .select()
    .from(purchasesBills)
    .where(and(...conditions))
    .orderBy(asc(purchasesBills.dueDate), asc(purchasesBills.billDate), asc(purchasesBills.id))
    .limit(query.limit);
}
