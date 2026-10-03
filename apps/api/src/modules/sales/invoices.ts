import { and, asc, desc, eq, ilike, inArray, ne, or, sql, type SQL } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';
import { likeContains } from '../catalog/index.js';
import { salesInvoiceLines, salesInvoices, type InvoiceStatus } from './schema.js';

/** Invoice data access (Phase 3B steps 6–7, 12–13). Rules live in the application service. */

export type Invoice = typeof salesInvoices.$inferSelect;
export type InvoiceLine = typeof salesInvoiceLines.$inferSelect;
export type NewInvoice = typeof salesInvoices.$inferInsert;
export type InvoiceLineValues = Omit<
  typeof salesInvoiceLines.$inferInsert,
  'id' | 'organizationId' | 'invoiceId'
>;

const scoped = (organizationId: string, id: string) =>
  and(eq(salesInvoices.organizationId, organizationId), eq(salesInvoices.id, id));

export async function getInvoice(
  tx: Transaction,
  organizationId: string,
  id: string,
  options: { forUpdate?: boolean } = {},
): Promise<Invoice | undefined> {
  const query = tx.select().from(salesInvoices).where(scoped(organizationId, id));
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row;
}

/** Several invoices, locked in id order (receipts and credits lock their targets, avoiding deadlocks). */
export async function lockInvoices(
  tx: Transaction,
  organizationId: string,
  ids: readonly string[],
): Promise<Invoice[]> {
  if (ids.length === 0) return [];
  return tx
    .select()
    .from(salesInvoices)
    .where(
      and(eq(salesInvoices.organizationId, organizationId), inArray(salesInvoices.id, [...ids])),
    )
    .orderBy(asc(salesInvoices.id))
    .for('update');
}

export async function getInvoiceLines(
  tx: Transaction,
  organizationId: string,
  invoiceId: string,
): Promise<InvoiceLine[]> {
  return tx
    .select()
    .from(salesInvoiceLines)
    .where(
      and(
        eq(salesInvoiceLines.organizationId, organizationId),
        eq(salesInvoiceLines.invoiceId, invoiceId),
      ),
    )
    .orderBy(asc(salesInvoiceLines.lineNo));
}

export async function insertInvoice(tx: Transaction, values: NewInvoice): Promise<Invoice> {
  const [row] = await tx.insert(salesInvoices).values(values).returning();
  return row!;
}

/**
 * Updates an invoice when it is still in `from` (and at `version`, when given), bumping the
 * version. Returns undefined when someone else changed it first.
 */
export async function updateInvoice(
  tx: Transaction,
  input: {
    organizationId: string;
    id: string;
    from: InvoiceStatus | readonly InvoiceStatus[];
    version?: number | undefined;
    set: Partial<NewInvoice>;
  },
): Promise<Invoice | undefined> {
  const from = typeof input.from === 'string' ? [input.from] : [...input.from];
  const [row] = await tx
    .update(salesInvoices)
    .set({ ...input.set, version: sql`${salesInvoices.version} + 1` })
    .where(
      and(
        scoped(input.organizationId, input.id),
        inArray(salesInvoices.status, from),
        input.version === undefined ? undefined : eq(salesInvoices.version, input.version),
      ),
    )
    .returning();
  return row;
}

export async function replaceInvoiceLines(
  tx: Transaction,
  organizationId: string,
  invoiceId: string,
  lines: readonly InvoiceLineValues[],
): Promise<InvoiceLine[]> {
  await tx
    .delete(salesInvoiceLines)
    .where(
      and(
        eq(salesInvoiceLines.organizationId, organizationId),
        eq(salesInvoiceLines.invoiceId, invoiceId),
      ),
    );
  if (lines.length === 0) return [];
  return tx
    .insert(salesInvoiceLines)
    .values(lines.map((l) => ({ ...l, organizationId, invoiceId })))
    .returning();
}

export async function deleteInvoice(tx: Transaction, organizationId: string, id: string) {
  const [row] = await tx
    .delete(salesInvoices)
    .where(and(scoped(organizationId, id), eq(salesInvoices.status, 'DRAFT')))
    .returning({ id: salesInvoices.id });
  return row !== undefined;
}

export interface InvoiceListQuery {
  organizationId: string;
  statuses: readonly InvoiceStatus[] | null;
  customerId: string | null;
  search: string | null;
  /** Also match these customers (a name search through the customers module). */
  customerIdsIn?: SQL | undefined;
  from: string | null;
  to: string | null;
  /** Only issued invoices with an open balance. */
  openOnly: boolean;
  limit: number;
  after: { date: string; id: string } | null;
}

/** Newest first: keyset on (invoice_date DESC, id DESC). */
export async function listInvoices(tx: Transaction, query: InvoiceListQuery) {
  const conditions: (SQL | undefined)[] = [eq(salesInvoices.organizationId, query.organizationId)];
  if (query.statuses) conditions.push(inArray(salesInvoices.status, [...query.statuses]));
  if (query.customerId) conditions.push(eq(salesInvoices.customerId, query.customerId));
  if (query.from) conditions.push(sql`${salesInvoices.invoiceDate} >= ${query.from}`);
  if (query.to) conditions.push(sql`${salesInvoices.invoiceDate} <= ${query.to}`);
  if (query.openOnly) {
    conditions.push(eq(salesInvoices.status, 'ISSUED'), sql`${salesInvoices.amountDue} > 0`);
  }
  if (query.search) {
    const pattern = likeContains(query.search);
    conditions.push(
      or(
        ilike(salesInvoices.number, pattern),
        ilike(salesInvoices.reference, pattern),
        query.customerIdsIn
          ? sql`${salesInvoices.customerId} IN (${query.customerIdsIn})`
          : undefined,
      ),
    );
  }
  if (query.after) {
    conditions.push(
      sql`(${salesInvoices.invoiceDate}, ${salesInvoices.id}) < (${query.after.date}::date, ${query.after.id}::uuid)`,
    );
  }
  const rows = await tx
    .select()
    .from(salesInvoices)
    .where(and(...conditions))
    .orderBy(desc(salesInvoices.invoiceDate), desc(salesInvoices.id))
    .limit(query.limit + 1);
  return { items: rows.slice(0, query.limit), hasMore: rows.length > query.limit };
}

/** Possible duplicates (Decision 23: detection is separate from idempotency). */
export async function findSimilarInvoices(
  tx: Transaction,
  input: {
    organizationId: string;
    customerId: string;
    invoiceDate: string;
    total: string;
    currencyCode: string;
    exceptId: string;
  },
) {
  return tx
    .select({ id: salesInvoices.id, number: salesInvoices.number, status: salesInvoices.status })
    .from(salesInvoices)
    .where(
      and(
        eq(salesInvoices.organizationId, input.organizationId),
        eq(salesInvoices.customerId, input.customerId),
        eq(salesInvoices.invoiceDate, input.invoiceDate),
        eq(salesInvoices.currencyCode, input.currencyCode),
        sql`${salesInvoices.total} = ${input.total}::numeric`,
        ne(salesInvoices.status, 'VOID'),
        ne(salesInvoices.id, input.exceptId),
      ),
    )
    .limit(5);
}

/** The customer's open balance in one currency (issued invoices only). */
export async function openInvoiceBalance(
  tx: Transaction,
  organizationId: string,
  customerId: string,
  currencyCode: string,
): Promise<string> {
  const [row] = await tx
    .select({ total: sql<string>`coalesce(sum(${salesInvoices.amountDue}), 0)::text` })
    .from(salesInvoices)
    .where(
      and(
        eq(salesInvoices.organizationId, organizationId),
        eq(salesInvoices.customerId, customerId),
        eq(salesInvoices.currencyCode, currencyCode),
        eq(salesInvoices.status, 'ISSUED'),
      ),
    );
  return row!.total;
}

export async function invoiceNumberExists(
  tx: Transaction,
  organizationId: string,
  number: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: salesInvoices.id })
    .from(salesInvoices)
    .where(and(eq(salesInvoices.organizationId, organizationId), eq(salesInvoices.number, number)))
    .limit(1);
  return row !== undefined;
}
