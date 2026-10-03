import { and, asc, eq, sql } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';
import { formatDocumentNumber, type NumberSequenceFields } from '../documents/index.js';
import {
  purchasesNumberSequences,
  purchasesSettings,
  type PurchaseDocumentType,
} from './schema.js';

/** Purchases settings and document numbering data access (ADR 0004 P4-07, P4-51; R37). */

export type PurchasesSettings = typeof purchasesSettings.$inferSelect;
export type PurchasesNumberSequence = typeof purchasesNumberSequences.$inferSelect;
export type PurchasesSettingsFields = Pick<
  PurchasesSettings,
  | 'apAccountId'
  | 'defaultExpenseAccountId'
  | 'defaultPaymentAccountId'
  | 'defaultTaxCodeId'
  | 'defaultTaxTreatment'
  | 'defaultPaymentTermsDays'
>;

/** Default numbering (P4-51): prefix, five digits, starting at 1. */
export const DEFAULT_PURCHASE_NUMBERING: Record<PurchaseDocumentType, NumberSequenceFields> = {
  bill: { prefix: 'BILL-', minDigits: 5, nextNumber: 1 },
  vendor_credit: { prefix: 'VC-', minDigits: 5, nextNumber: 1 },
  debit_note: { prefix: 'DN-', minDigits: 5, nextNumber: 1 },
  vendor_payment: { prefix: 'PAY-', minDigits: 5, nextNumber: 1 },
  vendor_refund: { prefix: 'VR-', minDigits: 5, nextNumber: 1 },
  expense: { prefix: 'EXP-', minDigits: 5, nextNumber: 1 },
};

export async function getPurchasesSettings(
  tx: Transaction,
  organizationId: string,
  options: { forUpdate?: boolean } = {},
): Promise<PurchasesSettings | undefined> {
  const query = tx
    .select()
    .from(purchasesSettings)
    .where(eq(purchasesSettings.organizationId, organizationId));
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row;
}

/** Creates the settings row and every number sequence (the first save). */
export async function insertPurchasesSettings(
  tx: Transaction,
  input: {
    organizationId: string;
    fields: PurchasesSettingsFields;
    numbering: Record<PurchaseDocumentType, NumberSequenceFields>;
    userId: string;
    now: Date;
  },
): Promise<PurchasesSettings | undefined> {
  const [row] = await tx
    .insert(purchasesSettings)
    .values({
      organizationId: input.organizationId,
      ...input.fields,
      createdByUserId: input.userId,
      createdAt: input.now,
      updatedByUserId: input.userId,
      updatedAt: input.now,
    })
    .onConflictDoNothing()
    .returning();
  if (!row) return undefined;
  await tx.insert(purchasesNumberSequences).values(
    (Object.keys(input.numbering) as PurchaseDocumentType[]).map((documentType) => ({
      organizationId: input.organizationId,
      documentType,
      ...input.numbering[documentType],
      updatedByUserId: input.userId,
      updatedAt: input.now,
    })),
  );
  return row;
}

export async function updatePurchasesSettings(
  tx: Transaction,
  input: {
    organizationId: string;
    version: number;
    set: Partial<PurchasesSettingsFields>;
    userId: string;
    now: Date;
  },
): Promise<PurchasesSettings | undefined> {
  const [row] = await tx
    .update(purchasesSettings)
    .set({
      ...input.set,
      version: sql`${purchasesSettings.version} + 1`,
      updatedByUserId: input.userId,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(purchasesSettings.organizationId, input.organizationId),
        eq(purchasesSettings.version, input.version),
      ),
    )
    .returning();
  return row;
}

export async function listPurchaseNumberSequences(
  tx: Transaction,
  organizationId: string,
  options: { forUpdate?: boolean } = {},
): Promise<PurchasesNumberSequence[]> {
  const query = tx
    .select()
    .from(purchasesNumberSequences)
    .where(eq(purchasesNumberSequences.organizationId, organizationId))
    .orderBy(asc(purchasesNumberSequences.documentType));
  return options.forUpdate ? query.for('update') : query;
}

export async function updatePurchaseNumberSequence(
  tx: Transaction,
  input: {
    organizationId: string;
    documentType: PurchaseDocumentType;
    set: Partial<NumberSequenceFields>;
    userId: string;
    now: Date;
  },
): Promise<PurchasesNumberSequence | undefined> {
  const [row] = await tx
    .update(purchasesNumberSequences)
    .set({
      ...input.set,
      version: sql`${purchasesNumberSequences.version} + 1`,
      updatedByUserId: input.userId,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(purchasesNumberSequences.organizationId, input.organizationId),
        eq(purchasesNumberSequences.documentType, input.documentType),
      ),
    )
    .returning();
  return row;
}

/**
 * Takes the next number of a Purchases sequence when a document is posted or recorded (P4-51;
 * never for drafts). The row stays locked until the posting transaction ends, so concurrent
 * postings get distinct numbers; a rolled-back posting may leave a gap, which is allowed (R37).
 * Used by the Purchases documents of later stages.
 */
export async function takeNextPurchaseNumber(
  tx: Transaction,
  organizationId: string,
  documentType: PurchaseDocumentType,
): Promise<{ number: string; sequenceValue: number } | undefined> {
  const [row] = await tx
    .update(purchasesNumberSequences)
    .set({ nextNumber: sql`${purchasesNumberSequences.nextNumber} + 1` })
    .where(
      and(
        eq(purchasesNumberSequences.organizationId, organizationId),
        eq(purchasesNumberSequences.documentType, documentType),
      ),
    )
    .returning();
  if (!row) return undefined;
  const value = row.nextNumber - 1;
  return { number: formatDocumentNumber(row, value), sequenceValue: value };
}

/** Records that Purchases documents exist: the AP control account is fixed from now on. */
export async function lockApAccount(tx: Transaction, organizationId: string, now: Date) {
  await tx
    .update(purchasesSettings)
    .set({ apLockedAt: now })
    .where(
      and(
        eq(purchasesSettings.organizationId, organizationId),
        sql`${purchasesSettings.apLockedAt} IS NULL`,
      ),
    );
}
