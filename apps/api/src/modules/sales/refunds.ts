import { and, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';
import { likeContains } from '../catalog/index.js';
import {
  customerRefundStatuses,
  salesRefundNumberSequences,
  salesRefunds,
  type CustomerRefundStatus,
} from './schema.js';

/** Customer refund data access (migration 0050). Rules live in the service. */

export { customerRefundStatuses };
export type { CustomerRefundStatus };
export type CustomerRefund = typeof salesRefunds.$inferSelect;
export type NewCustomerRefund = typeof salesRefunds.$inferInsert;

const scoped = (organizationId: string, id: string) =>
  and(eq(salesRefunds.organizationId, organizationId), eq(salesRefunds.id, id));

export async function getCustomerRefund(
  tx: Transaction,
  organizationId: string,
  id: string,
  options: { forUpdate?: boolean } = {},
): Promise<CustomerRefund | undefined> {
  const query = tx.select().from(salesRefunds).where(scoped(organizationId, id));
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row;
}

export async function insertCustomerRefund(
  tx: Transaction,
  values: NewCustomerRefund,
): Promise<CustomerRefund> {
  const [row] = await tx.insert(salesRefunds).values(values).returning();
  return row!;
}

/** Updates a recorded refund at `version` (the void), bumping the version. */
export async function updateCustomerRefund(
  tx: Transaction,
  input: { organizationId: string; id: string; version: number; set: Partial<NewCustomerRefund> },
): Promise<CustomerRefund | undefined> {
  const [row] = await tx
    .update(salesRefunds)
    .set({ ...input.set, version: sql`${salesRefunds.version} + 1` })
    .where(
      and(
        scoped(input.organizationId, input.id),
        eq(salesRefunds.status, 'RECORDED'),
        eq(salesRefunds.version, input.version),
      ),
    )
    .returning();
  return row;
}

export async function customerRefundNumberExists(
  tx: Transaction,
  organizationId: string,
  number: string,
) {
  const [row] = await tx
    .select({ id: salesRefunds.id })
    .from(salesRefunds)
    .where(and(eq(salesRefunds.organizationId, organizationId), eq(salesRefunds.number, number)))
    .limit(1);
  return row !== undefined;
}

/** Recorded (not void) refunds taken from a receipt or a credit note. */
export async function countActiveCustomerRefunds(
  tx: Transaction,
  organizationId: string,
  source: { receiptId?: string; creditNoteId?: string },
): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(salesRefunds)
    .where(
      and(
        eq(salesRefunds.organizationId, organizationId),
        eq(salesRefunds.status, 'RECORDED'),
        source.receiptId ? eq(salesRefunds.receiptId, source.receiptId) : undefined,
        source.creditNoteId ? eq(salesRefunds.creditNoteId, source.creditNoteId) : undefined,
      ),
    );
  return row?.n ?? 0;
}

/** Takes the next RF- number (the sequence row is created on first use). */
export async function takeNextCustomerRefundNumber(
  tx: Transaction,
  organizationId: string,
): Promise<string> {
  await tx
    .insert(salesRefundNumberSequences)
    .values({ organizationId, documentType: 'refund', prefix: 'RF-' })
    .onConflictDoNothing();
  const [row] = await tx
    .update(salesRefundNumberSequences)
    .set({ nextNumber: sql`${salesRefundNumberSequences.nextNumber} + 1` })
    .where(
      and(
        eq(salesRefundNumberSequences.organizationId, organizationId),
        eq(salesRefundNumberSequences.documentType, 'refund'),
      ),
    )
    .returning();
  const value = BigInt(row!.nextNumber) - 1n;
  return `${row!.prefix}${value.toString().padStart(row!.minDigits, '0')}`;
}

export interface CustomerRefundListQuery {
  organizationId: string;
  statuses: readonly CustomerRefundStatus[] | null;
  customerId: string | null;
  receiptId: string | null;
  creditNoteId: string | null;
  /** False hides refunds of credit notes (the viewer cannot see credit notes). */
  includeCreditNoteSources: boolean;
  search: string | null;
  /** Also match these customers (a name search through the customers module). */
  customerIdsIn?: SQL | undefined;
  limit: number;
  after: { date: string; id: string } | null;
}

/** Newest first: keyset on (refund_date DESC, id DESC). */
export async function listCustomerRefunds(tx: Transaction, query: CustomerRefundListQuery) {
  const conditions: (SQL | undefined)[] = [eq(salesRefunds.organizationId, query.organizationId)];
  if (query.statuses) conditions.push(inArray(salesRefunds.status, [...query.statuses]));
  if (query.customerId) conditions.push(eq(salesRefunds.customerId, query.customerId));
  if (query.receiptId) conditions.push(eq(salesRefunds.receiptId, query.receiptId));
  if (query.creditNoteId) conditions.push(eq(salesRefunds.creditNoteId, query.creditNoteId));
  if (!query.includeCreditNoteSources) conditions.push(eq(salesRefunds.sourceType, 'receipt'));
  if (query.search) {
    const pattern = likeContains(query.search);
    conditions.push(
      or(
        ilike(salesRefunds.number, pattern),
        ilike(salesRefunds.reference, pattern),
        query.customerIdsIn
          ? sql`${salesRefunds.customerId} IN (${query.customerIdsIn})`
          : undefined,
      ),
    );
  }
  if (query.after) {
    conditions.push(
      sql`(${salesRefunds.refundDate}, ${salesRefunds.id}) < (${query.after.date}::date, ${query.after.id}::uuid)`,
    );
  }
  const rows = await tx
    .select()
    .from(salesRefunds)
    .where(and(...conditions))
    .orderBy(desc(salesRefunds.refundDate), desc(salesRefunds.id))
    .limit(query.limit + 1);
  return { items: rows.slice(0, query.limit), hasMore: rows.length > query.limit };
}
