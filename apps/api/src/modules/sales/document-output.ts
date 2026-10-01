import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';
import { salesCreditNotes, salesDocumentEmails, salesInvoices } from './schema.js';

/** Issued-document PDFs and document email (Phase 3B steps 14–15; Decision 21, E4). */

export type OutputDocumentType = 'invoice' | 'credit_note';
export type DocumentEmail = typeof salesDocumentEmails.$inferSelect;

/** Links the rendered PDF once (only this column changes; the guard forbids replacing it). */
export async function attachDocumentPdf(
  tx: Transaction,
  organizationId: string,
  type: OutputDocumentType,
  id: string,
  fileId: string,
): Promise<boolean> {
  const table = type === 'invoice' ? salesInvoices : salesCreditNotes;
  const rows = await tx
    .update(table)
    .set({ pdfFileId: fileId })
    .where(and(eq(table.organizationId, organizationId), eq(table.id, id), isNull(table.pdfFileId)))
    .returning({ id: table.id });
  return rows.length > 0;
}

export async function insertDocumentEmail(
  tx: Transaction,
  values: typeof salesDocumentEmails.$inferInsert,
): Promise<DocumentEmail> {
  const [row] = await tx.insert(salesDocumentEmails).values(values).returning();
  return row!;
}

export async function getDocumentEmail(
  tx: Transaction,
  organizationId: string,
  id: string,
  options: { forUpdate?: boolean } = {},
): Promise<DocumentEmail | undefined> {
  const query = tx
    .select()
    .from(salesDocumentEmails)
    .where(
      and(eq(salesDocumentEmails.organizationId, organizationId), eq(salesDocumentEmails.id, id)),
    );
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row;
}

export async function completeDocumentEmail(
  tx: Transaction,
  organizationId: string,
  id: string,
  set: { status: 'sent' | 'failed'; sentAt: Date | null; fileId: string | null },
) {
  await tx
    .update(salesDocumentEmails)
    .set(set)
    .where(
      and(
        eq(salesDocumentEmails.organizationId, organizationId),
        eq(salesDocumentEmails.id, id),
        eq(salesDocumentEmails.status, 'queued'),
      ),
    );
}

export async function setDocumentEmailJob(
  tx: Transaction,
  organizationId: string,
  id: string,
  jobId: string,
) {
  await tx
    .update(salesDocumentEmails)
    .set({ jobId })
    .where(
      and(eq(salesDocumentEmails.organizationId, organizationId), eq(salesDocumentEmails.id, id)),
    );
}

export async function listDocumentEmails(
  tx: Transaction,
  organizationId: string,
  type: OutputDocumentType,
  documentId: string,
): Promise<DocumentEmail[]> {
  return tx
    .select()
    .from(salesDocumentEmails)
    .where(
      and(
        eq(salesDocumentEmails.organizationId, organizationId),
        eq(salesDocumentEmails.documentType, type),
        eq(salesDocumentEmails.documentId, documentId),
      ),
    )
    .orderBy(desc(salesDocumentEmails.requestedAt));
}
