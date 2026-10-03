import { and, asc, desc, eq, ilike, inArray, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';
import { likeContains } from '../catalog/index.js';
import {
  purchasesDocumentEmails,
  purchasesVendorCreditLines,
  purchasesVendorCredits,
  type VendorCreditOrigin,
  type VendorCreditStatus,
} from './schema.js';

/** Vendor credit and debit-note data access (ADR 0004 P4-23, P4-24, P4-46). */

export type VendorCredit = typeof purchasesVendorCredits.$inferSelect;
export type VendorCreditLine = typeof purchasesVendorCreditLines.$inferSelect;
export type NewVendorCredit = typeof purchasesVendorCredits.$inferInsert;
export type VendorCreditLineValues = Omit<
  typeof purchasesVendorCreditLines.$inferInsert,
  'id' | 'organizationId' | 'vendorCreditId'
>;
export type PurchasesDocumentEmail = typeof purchasesDocumentEmails.$inferSelect;

const scoped = (organizationId: string, id: string) =>
  and(eq(purchasesVendorCredits.organizationId, organizationId), eq(purchasesVendorCredits.id, id));

export async function getVendorCredit(
  tx: Transaction,
  organizationId: string,
  id: string,
  options: { forUpdate?: boolean } = {},
): Promise<VendorCredit | undefined> {
  const query = tx.select().from(purchasesVendorCredits).where(scoped(organizationId, id));
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row;
}

export async function getVendorCreditLines(
  tx: Transaction,
  organizationId: string,
  vendorCreditId: string,
): Promise<VendorCreditLine[]> {
  return tx
    .select()
    .from(purchasesVendorCreditLines)
    .where(
      and(
        eq(purchasesVendorCreditLines.organizationId, organizationId),
        eq(purchasesVendorCreditLines.vendorCreditId, vendorCreditId),
      ),
    )
    .orderBy(asc(purchasesVendorCreditLines.lineNo));
}

export async function insertVendorCredit(
  tx: Transaction,
  values: NewVendorCredit,
): Promise<VendorCredit> {
  const [row] = await tx.insert(purchasesVendorCredits).values(values).returning();
  return row!;
}

/**
 * Updates a vendor credit when it is still in `from` (and at `version`, when given), bumping the
 * version. Returns undefined when someone else changed it first.
 */
export async function updateVendorCredit(
  tx: Transaction,
  input: {
    organizationId: string;
    id: string;
    from: VendorCreditStatus | readonly VendorCreditStatus[];
    version?: number | undefined;
    set: Partial<NewVendorCredit>;
  },
): Promise<VendorCredit | undefined> {
  const from = typeof input.from === 'string' ? [input.from] : [...input.from];
  const [row] = await tx
    .update(purchasesVendorCredits)
    .set({ ...input.set, version: sql`${purchasesVendorCredits.version} + 1` })
    .where(
      and(
        scoped(input.organizationId, input.id),
        inArray(purchasesVendorCredits.status, from),
        input.version === undefined ? undefined : eq(purchasesVendorCredits.version, input.version),
      ),
    )
    .returning();
  return row;
}

export async function replaceVendorCreditLines(
  tx: Transaction,
  organizationId: string,
  vendorCreditId: string,
  lines: readonly VendorCreditLineValues[],
): Promise<VendorCreditLine[]> {
  await tx
    .delete(purchasesVendorCreditLines)
    .where(
      and(
        eq(purchasesVendorCreditLines.organizationId, organizationId),
        eq(purchasesVendorCreditLines.vendorCreditId, vendorCreditId),
      ),
    );
  if (lines.length === 0) return [];
  return tx
    .insert(purchasesVendorCreditLines)
    .values(lines.map((l) => ({ ...l, organizationId, vendorCreditId })))
    .returning();
}

export async function deleteVendorCredit(tx: Transaction, organizationId: string, id: string) {
  const [row] = await tx
    .delete(purchasesVendorCredits)
    .where(and(scoped(organizationId, id), eq(purchasesVendorCredits.status, 'DRAFT')))
    .returning({ id: purchasesVendorCredits.id });
  return row !== undefined;
}

export interface VendorCreditListQuery {
  organizationId: string;
  statuses: readonly VendorCreditStatus[] | null;
  origin: VendorCreditOrigin | null;
  vendorId: string | null;
  billId: string | null;
  search: string | null;
  vendorIdsIn?: SQL | undefined;
  limit: number;
  after: { date: string; id: string } | null;
}

/** Newest first: keyset on (credit_date DESC, id DESC). */
export async function listVendorCredits(tx: Transaction, query: VendorCreditListQuery) {
  const t = purchasesVendorCredits;
  const conditions: (SQL | undefined)[] = [eq(t.organizationId, query.organizationId)];
  if (query.statuses) conditions.push(inArray(t.status, [...query.statuses]));
  if (query.origin) conditions.push(eq(t.origin, query.origin));
  if (query.vendorId) conditions.push(eq(t.vendorId, query.vendorId));
  if (query.billId) conditions.push(eq(t.billId, query.billId));
  if (query.search) {
    const pattern = likeContains(query.search);
    conditions.push(
      or(
        ilike(t.number, pattern),
        ilike(t.vendorReference, pattern),
        query.vendorIdsIn ? sql`${t.vendorId} IN (${query.vendorIdsIn})` : undefined,
      ),
    );
  }
  if (query.after) {
    conditions.push(
      sql`(${t.creditDate}, ${t.id}) < (${query.after.date}::date, ${query.after.id}::uuid)`,
    );
  }
  const rows = await tx
    .select()
    .from(t)
    .where(and(...conditions))
    .orderBy(desc(t.creditDate), desc(t.id))
    .limit(query.limit + 1);
  return { items: rows.slice(0, query.limit), hasMore: rows.length > query.limit };
}

/** Warning only (decided 2026-10-03): other non-void credits of the vendor with the same reference. */
export async function findCreditReferenceDuplicates(
  tx: Transaction,
  input: { organizationId: string; vendorId: string; vendorReference: string; exceptId: string },
) {
  const t = purchasesVendorCredits;
  return tx
    .select({ id: t.id, number: t.number, status: t.status, creditDate: t.creditDate })
    .from(t)
    .where(
      and(
        eq(t.organizationId, input.organizationId),
        eq(t.vendorId, input.vendorId),
        sql`${t.vendorReferenceKey} = upper(regexp_replace(${input.vendorReference}::text, '\\s', '', 'g'))`,
        ne(t.status, 'VOID'),
        ne(t.id, input.exceptId),
      ),
    )
    .limit(5);
}

export async function vendorCreditNumberExists(
  tx: Transaction,
  organizationId: string,
  number: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: purchasesVendorCredits.id })
    .from(purchasesVendorCredits)
    .where(
      and(
        eq(purchasesVendorCredits.organizationId, organizationId),
        eq(purchasesVendorCredits.number, number),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** Links a debit note's rendered PDF once (the guard forbids replacing it). */
export async function attachVendorCreditPdf(
  tx: Transaction,
  organizationId: string,
  id: string,
  fileId: string,
): Promise<boolean> {
  const rows = await tx
    .update(purchasesVendorCredits)
    .set({ pdfFileId: fileId })
    .where(and(scoped(organizationId, id), isNull(purchasesVendorCredits.pdfFileId)))
    .returning({ id: purchasesVendorCredits.id });
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Debit-note email (P4-46)
// ---------------------------------------------------------------------------

export async function insertPurchasesDocumentEmail(
  tx: Transaction,
  values: typeof purchasesDocumentEmails.$inferInsert,
): Promise<PurchasesDocumentEmail> {
  const [row] = await tx.insert(purchasesDocumentEmails).values(values).returning();
  return row!;
}

export async function getPurchasesDocumentEmail(
  tx: Transaction,
  organizationId: string,
  id: string,
  options: { forUpdate?: boolean } = {},
): Promise<PurchasesDocumentEmail | undefined> {
  const t = purchasesDocumentEmails;
  const query = tx
    .select()
    .from(t)
    .where(and(eq(t.organizationId, organizationId), eq(t.id, id)));
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row;
}

export async function setPurchasesDocumentEmailJob(
  tx: Transaction,
  organizationId: string,
  id: string,
  jobId: string,
) {
  const t = purchasesDocumentEmails;
  await tx
    .update(t)
    .set({ jobId })
    .where(and(eq(t.organizationId, organizationId), eq(t.id, id)));
}

export async function completePurchasesDocumentEmail(
  tx: Transaction,
  organizationId: string,
  id: string,
  set: { status: 'sent' | 'failed'; sentAt: Date | null; fileId: string | null },
) {
  const t = purchasesDocumentEmails;
  await tx
    .update(t)
    .set(set)
    .where(and(eq(t.organizationId, organizationId), eq(t.id, id), eq(t.status, 'queued')));
}

export async function listPurchasesDocumentEmails(
  tx: Transaction,
  organizationId: string,
  documentId: string,
): Promise<PurchasesDocumentEmail[]> {
  const t = purchasesDocumentEmails;
  return tx
    .select()
    .from(t)
    .where(and(eq(t.organizationId, organizationId), eq(t.documentId, documentId)))
    .orderBy(desc(t.requestedAt));
}
