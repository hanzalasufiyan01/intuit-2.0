import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';
import { likeContains } from './items.js';
import { salesCreditNoteLines, salesCreditNotes, type CreditNoteStatus } from './schema.js';

/** Credit note data access (Phase 3B step 12; Decision 41, D7). */

export type CreditNote = typeof salesCreditNotes.$inferSelect;
export type CreditNoteLine = typeof salesCreditNoteLines.$inferSelect;
export type NewCreditNote = typeof salesCreditNotes.$inferInsert;
export type CreditNoteLineValues = Omit<
  typeof salesCreditNoteLines.$inferInsert,
  'id' | 'organizationId' | 'creditNoteId'
>;

const scoped = (organizationId: string, id: string) =>
  and(eq(salesCreditNotes.organizationId, organizationId), eq(salesCreditNotes.id, id));

export async function getCreditNote(
  tx: Transaction,
  organizationId: string,
  id: string,
  options: { forUpdate?: boolean } = {},
): Promise<CreditNote | undefined> {
  const query = tx.select().from(salesCreditNotes).where(scoped(organizationId, id));
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row;
}

export async function getCreditNoteLines(
  tx: Transaction,
  organizationId: string,
  creditNoteId: string,
): Promise<CreditNoteLine[]> {
  return tx
    .select()
    .from(salesCreditNoteLines)
    .where(
      and(
        eq(salesCreditNoteLines.organizationId, organizationId),
        eq(salesCreditNoteLines.creditNoteId, creditNoteId),
      ),
    )
    .orderBy(asc(salesCreditNoteLines.lineNo));
}

export async function insertCreditNote(
  tx: Transaction,
  values: NewCreditNote,
): Promise<CreditNote> {
  const [row] = await tx.insert(salesCreditNotes).values(values).returning();
  return row!;
}

export async function updateCreditNote(
  tx: Transaction,
  input: {
    organizationId: string;
    id: string;
    from: CreditNoteStatus | readonly CreditNoteStatus[];
    version?: number | undefined;
    set: Partial<NewCreditNote>;
  },
): Promise<CreditNote | undefined> {
  const from = typeof input.from === 'string' ? [input.from] : [...input.from];
  const [row] = await tx
    .update(salesCreditNotes)
    .set({ ...input.set, version: sql`${salesCreditNotes.version} + 1` })
    .where(
      and(
        scoped(input.organizationId, input.id),
        inArray(salesCreditNotes.status, from),
        input.version === undefined ? undefined : eq(salesCreditNotes.version, input.version),
      ),
    )
    .returning();
  return row;
}

export async function replaceCreditNoteLines(
  tx: Transaction,
  organizationId: string,
  creditNoteId: string,
  lines: readonly CreditNoteLineValues[],
): Promise<CreditNoteLine[]> {
  await tx
    .delete(salesCreditNoteLines)
    .where(
      and(
        eq(salesCreditNoteLines.organizationId, organizationId),
        eq(salesCreditNoteLines.creditNoteId, creditNoteId),
      ),
    );
  if (lines.length === 0) return [];
  return tx
    .insert(salesCreditNoteLines)
    .values(lines.map((l) => ({ ...l, organizationId, creditNoteId })))
    .returning();
}

export async function deleteCreditNote(tx: Transaction, organizationId: string, id: string) {
  const [row] = await tx
    .delete(salesCreditNotes)
    .where(and(scoped(organizationId, id), eq(salesCreditNotes.status, 'DRAFT')))
    .returning({ id: salesCreditNotes.id });
  return row !== undefined;
}

export async function creditNoteNumberExists(
  tx: Transaction,
  organizationId: string,
  number: string,
) {
  const [row] = await tx
    .select({ id: salesCreditNotes.id })
    .from(salesCreditNotes)
    .where(
      and(eq(salesCreditNotes.organizationId, organizationId), eq(salesCreditNotes.number, number)),
    )
    .limit(1);
  return row !== undefined;
}

/** The total of issued credit notes linked to an invoice. */
export async function creditedOnInvoice(
  tx: Transaction,
  organizationId: string,
  invoiceId: string,
  exceptId: string,
): Promise<string> {
  const [row] = await tx
    .select({ total: sql<string>`coalesce(sum(${salesCreditNotes.total}), 0)::text` })
    .from(salesCreditNotes)
    .where(
      and(
        eq(salesCreditNotes.organizationId, organizationId),
        eq(salesCreditNotes.invoiceId, invoiceId),
        eq(salesCreditNotes.status, 'ISSUED'),
        sql`${salesCreditNotes.id} <> ${exceptId}`,
      ),
    );
  return row!.total;
}

export interface CreditNoteListQuery {
  organizationId: string;
  status: CreditNoteStatus | null;
  customerId: string | null;
  invoiceId: string | null;
  search: string | null;
  /** Also match these customers (a name search through the customers module). */
  customerIdsIn?: SQL | undefined;
  withCredit: boolean;
  limit: number;
  after: { date: string; id: string } | null;
}

export async function listCreditNotes(tx: Transaction, query: CreditNoteListQuery) {
  const conditions: (SQL | undefined)[] = [
    eq(salesCreditNotes.organizationId, query.organizationId),
  ];
  if (query.status) conditions.push(eq(salesCreditNotes.status, query.status));
  if (query.customerId) conditions.push(eq(salesCreditNotes.customerId, query.customerId));
  if (query.invoiceId) conditions.push(eq(salesCreditNotes.invoiceId, query.invoiceId));
  if (query.withCredit) {
    conditions.push(
      eq(salesCreditNotes.status, 'ISSUED'),
      sql`${salesCreditNotes.amountUnapplied} > 0`,
    );
  }
  if (query.search) {
    const pattern = likeContains(query.search);
    conditions.push(
      or(
        ilike(salesCreditNotes.number, pattern),
        ilike(salesCreditNotes.reference, pattern),
        query.customerIdsIn
          ? sql`${salesCreditNotes.customerId} IN (${query.customerIdsIn})`
          : undefined,
      ),
    );
  }
  if (query.after) {
    conditions.push(
      sql`(${salesCreditNotes.creditDate}, ${salesCreditNotes.id}) < (${query.after.date}::date, ${query.after.id}::uuid)`,
    );
  }
  const rows = await tx
    .select()
    .from(salesCreditNotes)
    .where(and(...conditions))
    .orderBy(desc(salesCreditNotes.creditDate), desc(salesCreditNotes.id))
    .limit(query.limit + 1);
  return { items: rows.slice(0, query.limit), hasMore: rows.length > query.limit };
}

/** Changes an issued credit note's unapplied credit (applications). */
export async function adjustCreditNoteBalance(
  tx: Transaction,
  input: {
    organizationId: string;
    id: string;
    amount: string;
    base: string;
    now: Date;
    userId: string;
  },
) {
  const [row] = await tx
    .update(salesCreditNotes)
    .set({
      amountUnapplied: sql`${salesCreditNotes.amountUnapplied} + ${input.amount}::numeric`,
      baseUnapplied: sql`${salesCreditNotes.baseUnapplied} + ${input.base}::numeric`,
      version: sql`${salesCreditNotes.version} + 1`,
      updatedAt: input.now,
      updatedByUserId: input.userId,
    })
    .where(and(scoped(input.organizationId, input.id), eq(salesCreditNotes.status, 'ISSUED')))
    .returning();
  return row;
}
