import { and, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';
import { likeContains } from '../catalog/index.js';
import { purchasesRefunds, type RefundStatus } from './schema.js';

/** Vendor refund data access (Phase 4B-3; ADR 0004 P4-30, P4-33). Rules live in the service. */

export type Refund = typeof purchasesRefunds.$inferSelect;
export type NewRefund = typeof purchasesRefunds.$inferInsert;

const scoped = (organizationId: string, id: string) =>
  and(eq(purchasesRefunds.organizationId, organizationId), eq(purchasesRefunds.id, id));

export async function getRefund(
  tx: Transaction,
  organizationId: string,
  id: string,
  options: { forUpdate?: boolean } = {},
): Promise<Refund | undefined> {
  const query = tx.select().from(purchasesRefunds).where(scoped(organizationId, id));
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row;
}

export async function insertRefund(tx: Transaction, values: NewRefund): Promise<Refund> {
  const [row] = await tx.insert(purchasesRefunds).values(values).returning();
  return row!;
}

/** Updates a recorded refund at `version` (the void), bumping the version. */
export async function updateRefund(
  tx: Transaction,
  input: { organizationId: string; id: string; version: number; set: Partial<NewRefund> },
): Promise<Refund | undefined> {
  const [row] = await tx
    .update(purchasesRefunds)
    .set({ ...input.set, version: sql`${purchasesRefunds.version} + 1` })
    .where(
      and(
        scoped(input.organizationId, input.id),
        eq(purchasesRefunds.status, 'RECORDED'),
        eq(purchasesRefunds.version, input.version),
      ),
    )
    .returning();
  return row;
}

export async function refundNumberExists(tx: Transaction, organizationId: string, number: string) {
  const [row] = await tx
    .select({ id: purchasesRefunds.id })
    .from(purchasesRefunds)
    .where(
      and(eq(purchasesRefunds.organizationId, organizationId), eq(purchasesRefunds.number, number)),
    )
    .limit(1);
  return row !== undefined;
}

/** Recorded (not void) refunds taken from a payment or a vendor credit (P4-33). */
export async function countActiveRefunds(
  tx: Transaction,
  organizationId: string,
  source: { paymentId?: string; vendorCreditId?: string },
): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(purchasesRefunds)
    .where(
      and(
        eq(purchasesRefunds.organizationId, organizationId),
        eq(purchasesRefunds.status, 'RECORDED'),
        source.paymentId ? eq(purchasesRefunds.paymentId, source.paymentId) : undefined,
        source.vendorCreditId
          ? eq(purchasesRefunds.vendorCreditId, source.vendorCreditId)
          : undefined,
      ),
    );
  return row?.n ?? 0;
}

export interface RefundListQuery {
  organizationId: string;
  statuses: readonly RefundStatus[] | null;
  vendorId: string | null;
  paymentId: string | null;
  vendorCreditId: string | null;
  /** False hides refunds of vendor credits (the viewer cannot see vendor credits). */
  includeCreditSources: boolean;
  search: string | null;
  /** Also match these vendors (a name search through the vendors module). */
  vendorIdsIn?: SQL | undefined;
  limit: number;
  after: { date: string; id: string } | null;
}

/** Newest first: keyset on (refund_date DESC, id DESC). */
export async function listRefunds(tx: Transaction, query: RefundListQuery) {
  const conditions: (SQL | undefined)[] = [
    eq(purchasesRefunds.organizationId, query.organizationId),
  ];
  if (query.statuses) conditions.push(inArray(purchasesRefunds.status, [...query.statuses]));
  if (query.vendorId) conditions.push(eq(purchasesRefunds.vendorId, query.vendorId));
  if (query.paymentId) conditions.push(eq(purchasesRefunds.paymentId, query.paymentId));
  if (query.vendorCreditId) {
    conditions.push(eq(purchasesRefunds.vendorCreditId, query.vendorCreditId));
  }
  if (!query.includeCreditSources) conditions.push(eq(purchasesRefunds.sourceType, 'payment'));
  if (query.search) {
    const pattern = likeContains(query.search);
    conditions.push(
      or(
        ilike(purchasesRefunds.number, pattern),
        ilike(purchasesRefunds.reference, pattern),
        query.vendorIdsIn ? sql`${purchasesRefunds.vendorId} IN (${query.vendorIdsIn})` : undefined,
      ),
    );
  }
  if (query.after) {
    conditions.push(
      sql`(${purchasesRefunds.refundDate}, ${purchasesRefunds.id}) < (${query.after.date}::date, ${query.after.id}::uuid)`,
    );
  }
  const rows = await tx
    .select()
    .from(purchasesRefunds)
    .where(and(...conditions))
    .orderBy(desc(purchasesRefunds.refundDate), desc(purchasesRefunds.id))
    .limit(query.limit + 1);
  return { items: rows.slice(0, query.limit), hasMore: rows.length > query.limit };
}
