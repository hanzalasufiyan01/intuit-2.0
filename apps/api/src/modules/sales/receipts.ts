import { and, asc, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';
import { likeContains } from './items.js';
import { salesAllocations, salesInvoices, salesReceipts, type ReceiptStatus } from './schema.js';

/** Receipt and allocation data access (Phase 3B steps 8–11). */

export type Receipt = typeof salesReceipts.$inferSelect;
export type NewReceipt = typeof salesReceipts.$inferInsert;
export type Allocation = typeof salesAllocations.$inferSelect;
export type NewAllocation = typeof salesAllocations.$inferInsert;

const scoped = (organizationId: string, id: string) =>
  and(eq(salesReceipts.organizationId, organizationId), eq(salesReceipts.id, id));

export async function getReceipt(
  tx: Transaction,
  organizationId: string,
  id: string,
  options: { forUpdate?: boolean } = {},
): Promise<Receipt | undefined> {
  const query = tx.select().from(salesReceipts).where(scoped(organizationId, id));
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row;
}

export async function insertReceipt(tx: Transaction, values: NewReceipt): Promise<Receipt> {
  const [row] = await tx.insert(salesReceipts).values(values).returning();
  return row!;
}

export async function updateReceipt(
  tx: Transaction,
  input: {
    organizationId: string;
    id: string;
    version?: number | undefined;
    set: Partial<NewReceipt>;
  },
): Promise<Receipt | undefined> {
  const [row] = await tx
    .update(salesReceipts)
    .set({ ...input.set, version: sql`${salesReceipts.version} + 1` })
    .where(
      and(
        scoped(input.organizationId, input.id),
        eq(salesReceipts.status, 'RECORDED'),
        input.version === undefined ? undefined : eq(salesReceipts.version, input.version),
      ),
    )
    .returning();
  return row;
}

export async function receiptNumberExists(tx: Transaction, organizationId: string, number: string) {
  const [row] = await tx
    .select({ id: salesReceipts.id })
    .from(salesReceipts)
    .where(and(eq(salesReceipts.organizationId, organizationId), eq(salesReceipts.number, number)))
    .limit(1);
  return row !== undefined;
}

export interface ReceiptListQuery {
  organizationId: string;
  status: ReceiptStatus | null;
  customerId: string | null;
  search: string | null;
  /** Also match these customers (a name search through the customers module). */
  customerIdsIn?: SQL | undefined;
  withCredit: boolean;
  limit: number;
  after: { date: string; id: string } | null;
}

export async function listReceipts(tx: Transaction, query: ReceiptListQuery) {
  const conditions: (SQL | undefined)[] = [eq(salesReceipts.organizationId, query.organizationId)];
  if (query.status) conditions.push(eq(salesReceipts.status, query.status));
  if (query.customerId) conditions.push(eq(salesReceipts.customerId, query.customerId));
  if (query.withCredit) conditions.push(sql`${salesReceipts.amountUnallocated} > 0`);
  if (query.search) {
    const pattern = likeContains(query.search);
    conditions.push(
      or(
        ilike(salesReceipts.number, pattern),
        ilike(salesReceipts.reference, pattern),
        query.customerIdsIn
          ? sql`${salesReceipts.customerId} IN (${query.customerIdsIn})`
          : undefined,
      ),
    );
  }
  if (query.after) {
    conditions.push(
      sql`(${salesReceipts.receiptDate}, ${salesReceipts.id}) < (${query.after.date}::date, ${query.after.id}::uuid)`,
    );
  }
  const rows = await tx
    .select()
    .from(salesReceipts)
    .where(and(...conditions))
    .orderBy(desc(salesReceipts.receiptDate), desc(salesReceipts.id))
    .limit(query.limit + 1);
  return { items: rows.slice(0, query.limit), hasMore: rows.length > query.limit };
}

export async function insertAllocations(
  tx: Transaction,
  rows: readonly NewAllocation[],
): Promise<Allocation[]> {
  if (rows.length === 0) return [];
  return tx
    .insert(salesAllocations)
    .values([...rows])
    .returning();
}

/** Allocations touching a receipt, a credit note or an invoice, oldest first. */
export async function listAllocations(
  tx: Transaction,
  organizationId: string,
  filter: { receiptId?: string; creditNoteId?: string; invoiceId?: string },
): Promise<Allocation[]> {
  return tx
    .select()
    .from(salesAllocations)
    .where(
      and(
        eq(salesAllocations.organizationId, organizationId),
        filter.receiptId ? eq(salesAllocations.receiptId, filter.receiptId) : undefined,
        filter.creditNoteId ? eq(salesAllocations.creditNoteId, filter.creditNoteId) : undefined,
        filter.invoiceId ? eq(salesAllocations.invoiceId, filter.invoiceId) : undefined,
      ),
    )
    .orderBy(asc(salesAllocations.createdAt), asc(salesAllocations.id));
}

/** Allocations not yet reversed (a reversing row points at the one it cancels). */
export function unreversed(allocations: readonly Allocation[]): Allocation[] {
  const reversed = new Set(
    allocations.map((a) => a.reversesAllocationId).filter((id): id is string => id !== null),
  );
  return allocations.filter((a) => a.reversesAllocationId === null && !reversed.has(a.id));
}

/** Changes an issued invoice's open balance (receipts, credits, voids). */
export async function adjustInvoiceBalance(
  tx: Transaction,
  input: {
    organizationId: string;
    invoiceId: string;
    amount: string;
    base: string;
    now: Date;
    userId: string;
  },
) {
  const [row] = await tx
    .update(salesInvoices)
    .set({
      amountDue: sql`${salesInvoices.amountDue} + ${input.amount}::numeric`,
      baseDue: sql`${salesInvoices.baseDue} + ${input.base}::numeric`,
      version: sql`${salesInvoices.version} + 1`,
      updatedAt: input.now,
      updatedByUserId: input.userId,
    })
    .where(
      and(
        eq(salesInvoices.organizationId, input.organizationId),
        eq(salesInvoices.id, input.invoiceId),
        eq(salesInvoices.status, 'ISSUED'),
      ),
    )
    .returning();
  return row;
}
