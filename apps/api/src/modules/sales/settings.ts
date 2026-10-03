import { and, asc, eq, sql } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';
import { formatDocumentNumber } from '../documents/index.js';
import { salesNumberSequences, salesSettings, type SalesDocumentType } from './schema.js';

/** Sales settings and document numbering data access (D3, D7; R37). */

export type SalesSettings = typeof salesSettings.$inferSelect;
export type SalesNumberSequence = typeof salesNumberSequences.$inferSelect;
export type SalesSettingsFields = Pick<
  SalesSettings,
  | 'arAccountId'
  | 'defaultRevenueAccountId'
  | 'defaultDepositAccountId'
  | 'defaultTaxCodeId'
  | 'defaultTaxTreatment'
  | 'defaultPaymentTermsDays'
>;
export type NumberingFields = Pick<SalesNumberSequence, 'prefix' | 'minDigits' | 'nextNumber'>;

export const DEFAULT_NUMBERING: Record<SalesDocumentType, NumberingFields> = {
  invoice: { prefix: 'INV-', minDigits: 5, nextNumber: 1 },
  credit_note: { prefix: 'CN-', minDigits: 5, nextNumber: 1 },
  receipt: { prefix: 'RCT-', minDigits: 5, nextNumber: 1 },
};

export async function getSalesSettings(
  tx: Transaction,
  organizationId: string,
  options: { forUpdate?: boolean } = {},
): Promise<SalesSettings | undefined> {
  const query = tx
    .select()
    .from(salesSettings)
    .where(eq(salesSettings.organizationId, organizationId));
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row;
}

/** Creates the settings row and its three number sequences (the first save). */
export async function insertSalesSettings(
  tx: Transaction,
  input: {
    organizationId: string;
    fields: SalesSettingsFields;
    numbering: Record<SalesDocumentType, NumberingFields>;
    userId: string;
    now: Date;
  },
): Promise<SalesSettings | undefined> {
  const [row] = await tx
    .insert(salesSettings)
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
  await tx.insert(salesNumberSequences).values(
    (Object.keys(input.numbering) as SalesDocumentType[]).map((documentType) => ({
      organizationId: input.organizationId,
      documentType,
      ...input.numbering[documentType],
      updatedByUserId: input.userId,
      updatedAt: input.now,
    })),
  );
  return row;
}

export async function updateSalesSettings(
  tx: Transaction,
  input: {
    organizationId: string;
    version: number;
    set: Partial<SalesSettingsFields>;
    userId: string;
    now: Date;
  },
): Promise<SalesSettings | undefined> {
  const [row] = await tx
    .update(salesSettings)
    .set({
      ...input.set,
      version: sql`${salesSettings.version} + 1`,
      updatedByUserId: input.userId,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(salesSettings.organizationId, input.organizationId),
        eq(salesSettings.version, input.version),
      ),
    )
    .returning();
  return row;
}

export async function listNumberSequences(
  tx: Transaction,
  organizationId: string,
  options: { forUpdate?: boolean } = {},
): Promise<SalesNumberSequence[]> {
  const query = tx
    .select()
    .from(salesNumberSequences)
    .where(eq(salesNumberSequences.organizationId, organizationId))
    .orderBy(asc(salesNumberSequences.documentType));
  return options.forUpdate ? query.for('update') : query;
}

export async function updateNumberSequence(
  tx: Transaction,
  input: {
    organizationId: string;
    documentType: SalesDocumentType;
    set: Partial<NumberingFields>;
    userId: string;
    now: Date;
  },
): Promise<SalesNumberSequence | undefined> {
  const [row] = await tx
    .update(salesNumberSequences)
    .set({
      ...input.set,
      version: sql`${salesNumberSequences.version} + 1`,
      updatedByUserId: input.userId,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(salesNumberSequences.organizationId, input.organizationId),
        eq(salesNumberSequences.documentType, input.documentType),
      ),
    )
    .returning();
  return row;
}

/**
 * Takes the next number of a sequence at issue (D3). The row stays locked until the issuing
 * transaction ends, so concurrent issues get distinct numbers; a rolled-back issue may leave a
 * gap, which is allowed (R37).
 */
export async function takeNextNumber(
  tx: Transaction,
  organizationId: string,
  documentType: SalesDocumentType,
): Promise<{ number: string; sequenceValue: number } | undefined> {
  const [row] = await tx
    .update(salesNumberSequences)
    .set({ nextNumber: sql`${salesNumberSequences.nextNumber} + 1` })
    .where(
      and(
        eq(salesNumberSequences.organizationId, organizationId),
        eq(salesNumberSequences.documentType, documentType),
      ),
    )
    .returning();
  if (!row) return undefined;
  const value = row.nextNumber - 1;
  return { number: formatDocumentNumber(row, value), sequenceValue: value };
}

/** Records that Sales documents exist: the AR control account is fixed from now on (D12). */
export async function lockArAccount(tx: Transaction, organizationId: string, now: Date) {
  await tx
    .update(salesSettings)
    .set({ arLockedAt: now })
    .where(
      and(
        eq(salesSettings.organizationId, organizationId),
        sql`${salesSettings.arLockedAt} IS NULL`,
      ),
    );
}
