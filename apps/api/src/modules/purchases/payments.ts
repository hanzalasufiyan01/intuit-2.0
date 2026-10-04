import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';
import { likeContains } from '../catalog/index.js';
import {
  purchasesAllocations,
  purchasesBills,
  purchasesPaymentPlannedAllocations,
  purchasesPayments,
  purchasesVendorCredits,
  type PaymentStatus,
} from './schema.js';
import type { Bill } from './bills.js';

/**
 * Vendor payment, planned-allocation and allocation data access (Phase 4B-2; ADR 0004 P4-25 to
 * P4-29, P4-33). Rules live in the application services.
 */

export type Payment = typeof purchasesPayments.$inferSelect;
export type NewPayment = typeof purchasesPayments.$inferInsert;
export type PlannedAllocation = typeof purchasesPaymentPlannedAllocations.$inferSelect;
export type PurchasesAllocation = typeof purchasesAllocations.$inferSelect;
export type NewPurchasesAllocation = typeof purchasesAllocations.$inferInsert;

const scoped = (organizationId: string, id: string) =>
  and(eq(purchasesPayments.organizationId, organizationId), eq(purchasesPayments.id, id));

export async function getPayment(
  tx: Transaction,
  organizationId: string,
  id: string,
  options: { forUpdate?: boolean } = {},
): Promise<Payment | undefined> {
  const query = tx.select().from(purchasesPayments).where(scoped(organizationId, id));
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row;
}

export async function insertPayment(tx: Transaction, values: NewPayment): Promise<Payment> {
  const [row] = await tx.insert(purchasesPayments).values(values).returning();
  return row!;
}

/**
 * Updates a payment when it is still in `from` (and at `version`, when given), bumping the
 * version. Returns undefined when someone else changed it first.
 */
export async function updatePayment(
  tx: Transaction,
  input: {
    organizationId: string;
    id: string;
    from: PaymentStatus | readonly PaymentStatus[];
    version?: number | undefined;
    set: Partial<NewPayment>;
  },
): Promise<Payment | undefined> {
  const from = typeof input.from === 'string' ? [input.from] : [...input.from];
  const [row] = await tx
    .update(purchasesPayments)
    .set({ ...input.set, version: sql`${purchasesPayments.version} + 1` })
    .where(
      and(
        scoped(input.organizationId, input.id),
        inArray(purchasesPayments.status, from),
        input.version === undefined ? undefined : eq(purchasesPayments.version, input.version),
      ),
    )
    .returning();
  return row;
}

/** Deletes a draft payment and its planned allocations. */
export async function deletePayment(tx: Transaction, organizationId: string, id: string) {
  await replacePlannedAllocations(tx, organizationId, id, []);
  const [row] = await tx
    .delete(purchasesPayments)
    .where(and(scoped(organizationId, id), eq(purchasesPayments.status, 'DRAFT')))
    .returning({ id: purchasesPayments.id });
  return row !== undefined;
}

export async function getPlannedAllocations(
  tx: Transaction,
  organizationId: string,
  paymentId: string,
): Promise<PlannedAllocation[]> {
  return tx
    .select()
    .from(purchasesPaymentPlannedAllocations)
    .where(
      and(
        eq(purchasesPaymentPlannedAllocations.organizationId, organizationId),
        eq(purchasesPaymentPlannedAllocations.paymentId, paymentId),
      ),
    )
    .orderBy(asc(purchasesPaymentPlannedAllocations.lineNo));
}

/** Replaces a draft's planned allocations (the database refuses this once it is not a draft). */
export async function replacePlannedAllocations(
  tx: Transaction,
  organizationId: string,
  paymentId: string,
  rows: readonly { billId: string; amount: string }[],
): Promise<PlannedAllocation[]> {
  await tx
    .delete(purchasesPaymentPlannedAllocations)
    .where(
      and(
        eq(purchasesPaymentPlannedAllocations.organizationId, organizationId),
        eq(purchasesPaymentPlannedAllocations.paymentId, paymentId),
      ),
    );
  if (rows.length === 0) return [];
  return tx
    .insert(purchasesPaymentPlannedAllocations)
    .values(
      rows.map((r, i) => ({
        organizationId,
        paymentId,
        lineNo: i + 1,
        billId: r.billId,
        amount: r.amount,
      })),
    )
    .returning();
}

export async function paymentNumberExists(tx: Transaction, organizationId: string, number: string) {
  const [row] = await tx
    .select({ id: purchasesPayments.id })
    .from(purchasesPayments)
    .where(
      and(
        eq(purchasesPayments.organizationId, organizationId),
        eq(purchasesPayments.number, number),
      ),
    )
    .limit(1);
  return row !== undefined;
}

export interface PaymentListQuery {
  organizationId: string;
  statuses: readonly PaymentStatus[] | null;
  vendorId: string | null;
  /** Payments with a prepayment balance still to apply. */
  withUnallocated: boolean;
  search: string | null;
  /** Also match these vendors (a name search through the vendors module). */
  vendorIdsIn?: SQL | undefined;
  limit: number;
  after: { date: string; id: string } | null;
}

/** Newest first: keyset on (payment_date DESC, id DESC). */
export async function listPayments(tx: Transaction, query: PaymentListQuery) {
  const conditions: (SQL | undefined)[] = [
    eq(purchasesPayments.organizationId, query.organizationId),
  ];
  if (query.statuses) conditions.push(inArray(purchasesPayments.status, [...query.statuses]));
  if (query.vendorId) conditions.push(eq(purchasesPayments.vendorId, query.vendorId));
  if (query.withUnallocated) conditions.push(sql`${purchasesPayments.amountUnallocated} > 0`);
  if (query.search) {
    const pattern = likeContains(query.search);
    conditions.push(
      or(
        ilike(purchasesPayments.number, pattern),
        ilike(purchasesPayments.reference, pattern),
        query.vendorIdsIn
          ? sql`${purchasesPayments.vendorId} IN (${query.vendorIdsIn})`
          : undefined,
      ),
    );
  }
  if (query.after) {
    conditions.push(
      sql`(${purchasesPayments.paymentDate}, ${purchasesPayments.id}) < (${query.after.date}::date, ${query.after.id}::uuid)`,
    );
  }
  const rows = await tx
    .select()
    .from(purchasesPayments)
    .where(and(...conditions))
    .orderBy(desc(purchasesPayments.paymentDate), desc(purchasesPayments.id))
    .limit(query.limit + 1);
  return { items: rows.slice(0, query.limit), hasMore: rows.length > query.limit };
}

/** Locks bills in ascending id order (the frozen lock order: source, then bills by id). */
export async function lockBills(
  tx: Transaction,
  organizationId: string,
  ids: readonly string[],
): Promise<Bill[]> {
  if (ids.length === 0) return [];
  return tx
    .select()
    .from(purchasesBills)
    .where(
      and(eq(purchasesBills.organizationId, organizationId), inArray(purchasesBills.id, [...ids])),
    )
    .orderBy(asc(purchasesBills.id))
    .for('update');
}

/** Posted bills of a vendor in a currency that still have an amount due, oldest first. */
export async function listOpenBills(
  tx: Transaction,
  input: { organizationId: string; vendorId: string; currencyCode: string; limit: number },
): Promise<Bill[]> {
  return tx
    .select()
    .from(purchasesBills)
    .where(
      and(
        eq(purchasesBills.organizationId, input.organizationId),
        eq(purchasesBills.vendorId, input.vendorId),
        eq(purchasesBills.currencyCode, input.currencyCode),
        eq(purchasesBills.status, 'POSTED'),
        sql`${purchasesBills.amountDue} > 0`,
      ),
    )
    .orderBy(asc(purchasesBills.billDate), asc(purchasesBills.id))
    .limit(input.limit);
}

/** Changes a posted bill's open balance (payments, applications, voids). */
export async function adjustBillBalance(
  tx: Transaction,
  input: {
    organizationId: string;
    billId: string;
    amount: string;
    base: string;
    now: Date;
    userId: string;
  },
): Promise<Bill | undefined> {
  const [row] = await tx
    .update(purchasesBills)
    .set({
      amountDue: sql`${purchasesBills.amountDue} + ${input.amount}::numeric`,
      baseDue: sql`${purchasesBills.baseDue} + ${input.base}::numeric`,
      version: sql`${purchasesBills.version} + 1`,
      updatedAt: input.now,
      updatedByUserId: input.userId,
    })
    .where(
      and(
        eq(purchasesBills.organizationId, input.organizationId),
        eq(purchasesBills.id, input.billId),
        eq(purchasesBills.status, 'POSTED'),
      ),
    )
    .returning();
  return row;
}

/** Changes a posted vendor credit's unapplied balance (applications). */
export async function adjustVendorCreditBalance(
  tx: Transaction,
  input: {
    organizationId: string;
    vendorCreditId: string;
    amount: string;
    base: string;
    now: Date;
    userId: string;
  },
) {
  const [row] = await tx
    .update(purchasesVendorCredits)
    .set({
      amountUnapplied: sql`${purchasesVendorCredits.amountUnapplied} + ${input.amount}::numeric`,
      baseUnapplied: sql`${purchasesVendorCredits.baseUnapplied} + ${input.base}::numeric`,
      version: sql`${purchasesVendorCredits.version} + 1`,
      updatedAt: input.now,
      updatedByUserId: input.userId,
    })
    .where(
      and(
        eq(purchasesVendorCredits.organizationId, input.organizationId),
        eq(purchasesVendorCredits.id, input.vendorCreditId),
        eq(purchasesVendorCredits.status, 'POSTED'),
      ),
    )
    .returning();
  return row;
}

export async function insertPurchasesAllocations(
  tx: Transaction,
  rows: readonly NewPurchasesAllocation[],
): Promise<PurchasesAllocation[]> {
  if (rows.length === 0) return [];
  return tx
    .insert(purchasesAllocations)
    .values([...rows])
    .returning();
}

/** Allocations touching a payment, a vendor credit, a bill or an application, oldest first. */
export async function listPurchasesAllocations(
  tx: Transaction,
  organizationId: string,
  filter: { paymentId?: string; vendorCreditId?: string; billId?: string; applicationId?: string },
): Promise<PurchasesAllocation[]> {
  return tx
    .select()
    .from(purchasesAllocations)
    .where(
      and(
        eq(purchasesAllocations.organizationId, organizationId),
        filter.paymentId ? eq(purchasesAllocations.paymentId, filter.paymentId) : undefined,
        filter.vendorCreditId
          ? eq(purchasesAllocations.vendorCreditId, filter.vendorCreditId)
          : undefined,
        filter.billId ? eq(purchasesAllocations.billId, filter.billId) : undefined,
        filter.applicationId
          ? eq(purchasesAllocations.applicationId, filter.applicationId)
          : undefined,
      ),
    )
    .orderBy(asc(purchasesAllocations.createdAt), asc(purchasesAllocations.id));
}

/** Allocations not yet reversed (a reversing row points at the one it cancels). */
export function unreversedAllocations(
  allocations: readonly PurchasesAllocation[],
): PurchasesAllocation[] {
  const reversed = new Set(
    allocations.map((a) => a.reversesAllocationId).filter((id): id is string => id !== null),
  );
  return allocations.filter((a) => a.reversesAllocationId === null && !reversed.has(a.id));
}
