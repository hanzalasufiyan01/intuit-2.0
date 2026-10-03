import { and, asc, desc, eq, ilike, inArray, ne, or, sql, type SQL } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';
import { likeContains } from '../catalog/index.js';
import { purchasesBillLines, purchasesBills, type BillStatus } from './schema.js';

/** Bill data access (ADR 0004 P4-15 to P4-22). Rules live in the application service. */

export type Bill = typeof purchasesBills.$inferSelect;
export type BillLine = typeof purchasesBillLines.$inferSelect;
export type NewBill = typeof purchasesBills.$inferInsert;
export type BillLineValues = Omit<
  typeof purchasesBillLines.$inferInsert,
  'id' | 'organizationId' | 'billId'
>;

const scoped = (organizationId: string, id: string) =>
  and(eq(purchasesBills.organizationId, organizationId), eq(purchasesBills.id, id));

export async function getBill(
  tx: Transaction,
  organizationId: string,
  id: string,
  options: { forUpdate?: boolean } = {},
): Promise<Bill | undefined> {
  const query = tx.select().from(purchasesBills).where(scoped(organizationId, id));
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row;
}

export async function getBillLines(
  tx: Transaction,
  organizationId: string,
  billId: string,
): Promise<BillLine[]> {
  return tx
    .select()
    .from(purchasesBillLines)
    .where(
      and(
        eq(purchasesBillLines.organizationId, organizationId),
        eq(purchasesBillLines.billId, billId),
      ),
    )
    .orderBy(asc(purchasesBillLines.lineNo));
}

export async function insertBill(tx: Transaction, values: NewBill): Promise<Bill> {
  const [row] = await tx.insert(purchasesBills).values(values).returning();
  return row!;
}

/**
 * Updates a bill when it is still in `from` (and at `version`, when given), bumping the version.
 * Returns undefined when someone else changed it first.
 */
export async function updateBill(
  tx: Transaction,
  input: {
    organizationId: string;
    id: string;
    from: BillStatus | readonly BillStatus[];
    version?: number | undefined;
    set: Partial<NewBill>;
  },
): Promise<Bill | undefined> {
  const from = typeof input.from === 'string' ? [input.from] : [...input.from];
  const [row] = await tx
    .update(purchasesBills)
    .set({ ...input.set, version: sql`${purchasesBills.version} + 1` })
    .where(
      and(
        scoped(input.organizationId, input.id),
        inArray(purchasesBills.status, from),
        input.version === undefined ? undefined : eq(purchasesBills.version, input.version),
      ),
    )
    .returning();
  return row;
}

export async function replaceBillLines(
  tx: Transaction,
  organizationId: string,
  billId: string,
  lines: readonly BillLineValues[],
): Promise<BillLine[]> {
  await tx
    .delete(purchasesBillLines)
    .where(
      and(
        eq(purchasesBillLines.organizationId, organizationId),
        eq(purchasesBillLines.billId, billId),
      ),
    );
  if (lines.length === 0) return [];
  return tx
    .insert(purchasesBillLines)
    .values(lines.map((l) => ({ ...l, organizationId, billId })))
    .returning();
}

export async function deleteBill(tx: Transaction, organizationId: string, id: string) {
  const [row] = await tx
    .delete(purchasesBills)
    .where(and(scoped(organizationId, id), eq(purchasesBills.status, 'DRAFT')))
    .returning({ id: purchasesBills.id });
  return row !== undefined;
}

export interface BillListQuery {
  organizationId: string;
  statuses: readonly BillStatus[] | null;
  vendorId: string | null;
  search: string | null;
  /** Also match these vendors (a name search through the vendors module). */
  vendorIdsIn?: SQL | undefined;
  from: string | null;
  to: string | null;
  limit: number;
  after: { date: string; id: string } | null;
}

/** Newest first: keyset on (bill_date DESC, id DESC). */
export async function listBills(tx: Transaction, query: BillListQuery) {
  const conditions: (SQL | undefined)[] = [eq(purchasesBills.organizationId, query.organizationId)];
  if (query.statuses) conditions.push(inArray(purchasesBills.status, [...query.statuses]));
  if (query.vendorId) conditions.push(eq(purchasesBills.vendorId, query.vendorId));
  if (query.from) conditions.push(sql`${purchasesBills.billDate} >= ${query.from}`);
  if (query.to) conditions.push(sql`${purchasesBills.billDate} <= ${query.to}`);
  if (query.search) {
    const pattern = likeContains(query.search);
    conditions.push(
      or(
        ilike(purchasesBills.number, pattern),
        ilike(purchasesBills.vendorReference, pattern),
        query.vendorIdsIn ? sql`${purchasesBills.vendorId} IN (${query.vendorIdsIn})` : undefined,
      ),
    );
  }
  if (query.after) {
    conditions.push(
      sql`(${purchasesBills.billDate}, ${purchasesBills.id}) < (${query.after.date}::date, ${query.after.id}::uuid)`,
    );
  }
  const rows = await tx
    .select()
    .from(purchasesBills)
    .where(and(...conditions))
    .orderBy(desc(purchasesBills.billDate), desc(purchasesBills.id))
    .limit(query.limit + 1);
  return { items: rows.slice(0, query.limit), hasMore: rows.length > query.limit };
}

/**
 * P4-18: other non-void bills of the vendor with the same normalized supplier reference (case and
 * whitespace ignored, as the generated `vendor_reference_key`).
 */
export async function findDuplicateReferences(
  tx: Transaction,
  input: { organizationId: string; vendorId: string; vendorReference: string; exceptId: string },
) {
  return tx
    .select({
      id: purchasesBills.id,
      number: purchasesBills.number,
      status: purchasesBills.status,
      vendorReference: purchasesBills.vendorReference,
      billDate: purchasesBills.billDate,
    })
    .from(purchasesBills)
    .where(
      and(
        eq(purchasesBills.organizationId, input.organizationId),
        eq(purchasesBills.vendorId, input.vendorId),
        sql`${purchasesBills.vendorReferenceKey} = upper(regexp_replace(${input.vendorReference}::text, '\\s', '', 'g'))`,
        ne(purchasesBills.status, 'VOID'),
        ne(purchasesBills.id, input.exceptId),
      ),
    )
    .orderBy(asc(purchasesBills.billDate), asc(purchasesBills.id))
    .limit(5);
}

/**
 * P4-18: the non-blocking warning: other non-void bills of the vendor with the same total and
 * currency dated within 7 days of this one.
 */
export async function findSimilarBills(
  tx: Transaction,
  input: {
    organizationId: string;
    vendorId: string;
    billDate: string;
    total: string;
    currencyCode: string;
    exceptId: string;
  },
) {
  return tx
    .select({
      id: purchasesBills.id,
      number: purchasesBills.number,
      status: purchasesBills.status,
      billDate: purchasesBills.billDate,
    })
    .from(purchasesBills)
    .where(
      and(
        eq(purchasesBills.organizationId, input.organizationId),
        eq(purchasesBills.vendorId, input.vendorId),
        eq(purchasesBills.currencyCode, input.currencyCode),
        sql`${purchasesBills.total} = ${input.total}::numeric`,
        sql`abs(${purchasesBills.billDate} - ${input.billDate}::date) <= 7`,
        ne(purchasesBills.status, 'VOID'),
        ne(purchasesBills.id, input.exceptId),
      ),
    )
    .limit(5);
}

export async function billNumberExists(
  tx: Transaction,
  organizationId: string,
  number: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: purchasesBills.id })
    .from(purchasesBills)
    .where(
      and(eq(purchasesBills.organizationId, organizationId), eq(purchasesBills.number, number)),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * P4-18: serializes duplicate checks for one vendor and normalized reference within the posting
 * transaction (transaction-scoped advisory lock), so two concurrent posts cannot both pass.
 */
export async function lockDuplicateCheck(
  tx: Transaction,
  organizationId: string,
  vendorId: string,
  vendorReference: string,
) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`bill-ref:${organizationId}:${vendorId}:`} || upper(regexp_replace(${vendorReference}::text, '\\s', '', 'g')), 0))`,
  );
}
