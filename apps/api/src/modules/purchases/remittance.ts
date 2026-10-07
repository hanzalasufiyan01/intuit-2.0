import { and, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';
import { purchasesBills, purchasesPayments, purchasesRemittanceEmails } from './schema.js';

/**
 * Remittance-advice output data (Phase 4B-7; ADR 0004 P4-46; migration 0039). Output only: these
 * functions touch just the payment's two set-once output columns and the email requests, never
 * its accounting fields, allocations or balances. Rules live in the application service.
 */

export type RemittanceEmail = typeof purchasesRemittanceEmails.$inferSelect;

const payment = (organizationId: string, id: string) =>
  and(eq(purchasesPayments.organizationId, organizationId), eq(purchasesPayments.id, id));

/**
 * Freezes the advice content once (D4): only a RECORDED payment without a snapshot receives it.
 * Returns false when it already has one (or is not recorded), leaving the existing snapshot as it
 * is. The payment's version is not touched: output state is not an edit of the payment.
 */
export async function freezeRemittanceSnapshot(
  tx: Transaction,
  organizationId: string,
  paymentId: string,
  snapshot: Record<string, unknown>,
): Promise<boolean> {
  const rows = await tx
    .update(purchasesPayments)
    .set({ renderSnapshot: snapshot })
    .where(
      and(
        payment(organizationId, paymentId),
        eq(purchasesPayments.status, 'RECORDED'),
        isNull(purchasesPayments.renderSnapshot),
      ),
    )
    .returning({ id: purchasesPayments.id });
  return rows.length > 0;
}

/** Links the stored PDF once; false when the payment already has one or has no snapshot. */
export async function attachRemittancePdf(
  tx: Transaction,
  organizationId: string,
  paymentId: string,
  fileId: string,
): Promise<boolean> {
  const rows = await tx
    .update(purchasesPayments)
    .set({ remittancePdfFileId: fileId })
    .where(
      and(
        payment(organizationId, paymentId),
        eq(purchasesPayments.status, 'RECORDED'),
        isNotNull(purchasesPayments.renderSnapshot),
        isNull(purchasesPayments.remittancePdfFileId),
      ),
    )
    .returning({ id: purchasesPayments.id });
  return rows.length > 0;
}

/** The bills a payment settled, for the advice's lines. */
export async function listRemittanceBills(
  tx: Transaction,
  organizationId: string,
  billIds: readonly string[],
) {
  if (billIds.length === 0) return [];
  return tx
    .select({
      id: purchasesBills.id,
      number: purchasesBills.number,
      vendorReference: purchasesBills.vendorReference,
      billDate: purchasesBills.billDate,
      total: purchasesBills.total,
    })
    .from(purchasesBills)
    .where(
      and(
        eq(purchasesBills.organizationId, organizationId),
        inArray(purchasesBills.id, [...billIds]),
      ),
    );
}

// ---------------------------------------------------------------------------
// Remittance emails (D8, D13)
// ---------------------------------------------------------------------------

export async function insertRemittanceEmail(
  tx: Transaction,
  values: typeof purchasesRemittanceEmails.$inferInsert,
): Promise<RemittanceEmail> {
  const [row] = await tx.insert(purchasesRemittanceEmails).values(values).returning();
  return row!;
}

export async function getRemittanceEmail(
  tx: Transaction,
  organizationId: string,
  id: string,
  options: { forUpdate?: boolean } = {},
): Promise<RemittanceEmail | undefined> {
  const t = purchasesRemittanceEmails;
  const query = tx
    .select()
    .from(t)
    .where(and(eq(t.organizationId, organizationId), eq(t.id, id)));
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row;
}

export async function setRemittanceEmailJob(
  tx: Transaction,
  organizationId: string,
  id: string,
  jobId: string,
) {
  const t = purchasesRemittanceEmails;
  await tx
    .update(t)
    .set({ jobId })
    .where(and(eq(t.organizationId, organizationId), eq(t.id, id)));
}

/** queued → sent | failed, once (the database guard allows nothing else). */
export async function completeRemittanceEmail(
  tx: Transaction,
  organizationId: string,
  id: string,
  set: { status: 'sent' | 'failed'; sentAt: Date | null; fileId: string | null },
) {
  const t = purchasesRemittanceEmails;
  await tx
    .update(t)
    .set(set)
    .where(and(eq(t.organizationId, organizationId), eq(t.id, id), eq(t.status, 'queued')));
}

export async function listRemittanceEmails(
  tx: Transaction,
  organizationId: string,
  paymentId: string,
): Promise<RemittanceEmail[]> {
  const t = purchasesRemittanceEmails;
  return tx
    .select()
    .from(t)
    .where(and(eq(t.organizationId, organizationId), eq(t.paymentId, paymentId)))
    .orderBy(desc(t.requestedAt), desc(t.id));
}
