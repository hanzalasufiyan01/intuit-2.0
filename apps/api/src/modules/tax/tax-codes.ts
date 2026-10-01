import { and, asc, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';
import { findAccountByCode, hasChildAccounts } from '../accounting/index.js';
import { taxCodeRates, taxCodes } from './schema.js';

/** Tax code data access (Decision 15). No calculation happens here. */

export type TaxCode = typeof taxCodes.$inferSelect;
export type TaxCodeRate = typeof taxCodeRates.$inferSelect;

export const MIRA_VERIFICATION_NOTE =
  'Seeded from the Maldives localization; verify against MIRA before production use.';

export async function listTaxCodes(tx: Transaction, organizationId: string): Promise<TaxCode[]> {
  return tx
    .select()
    .from(taxCodes)
    .where(eq(taxCodes.organizationId, organizationId))
    .orderBy(asc(taxCodes.code));
}

export async function listTaxCodeRates(
  tx: Transaction,
  organizationId: string,
  taxCodeIds: readonly string[],
): Promise<TaxCodeRate[]> {
  if (taxCodeIds.length === 0) return [];
  return tx
    .select()
    .from(taxCodeRates)
    .where(
      and(
        eq(taxCodeRates.organizationId, organizationId),
        inArray(taxCodeRates.taxCodeId, [...taxCodeIds]),
      ),
    )
    .orderBy(asc(taxCodeRates.effectiveFrom));
}

export async function getTaxCode(
  tx: Transaction,
  organizationId: string,
  id: string,
  options: { forUpdate?: boolean } = {},
): Promise<TaxCode | undefined> {
  const query = tx
    .select()
    .from(taxCodes)
    .where(and(eq(taxCodes.organizationId, organizationId), eq(taxCodes.id, id)));
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row;
}

export async function insertTaxCode(
  tx: Transaction,
  input: {
    organizationId: string;
    code: string;
    name: string;
    description: string;
    taxAccountId: string;
    userId: string | null;
    now: Date;
  },
): Promise<TaxCode | undefined> {
  const [row] = await tx
    .insert(taxCodes)
    .values({
      organizationId: input.organizationId,
      code: input.code,
      name: input.name,
      description: input.description,
      taxAccountId: input.taxAccountId,
      createdByUserId: input.userId,
      createdAt: input.now,
      updatedByUserId: input.userId,
      updatedAt: input.now,
    })
    .onConflictDoNothing()
    .returning();
  return row;
}

/** Updates a code at the expected version (compare-and-set), bumping the version. */
export async function updateTaxCode(
  tx: Transaction,
  input: {
    organizationId: string;
    id: string;
    version: number;
    set: Partial<Pick<TaxCode, 'name' | 'description' | 'taxAccountId' | 'status'>>;
    userId: string;
    now: Date;
  },
): Promise<TaxCode | undefined> {
  const [row] = await tx
    .update(taxCodes)
    .set({
      ...input.set,
      version: sql`${taxCodes.version} + 1`,
      updatedByUserId: input.userId,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(taxCodes.organizationId, input.organizationId),
        eq(taxCodes.id, input.id),
        eq(taxCodes.version, input.version),
      ),
    )
    .returning();
  return row;
}

export async function insertTaxCodeRate(
  tx: Transaction,
  input: {
    organizationId: string;
    taxCodeId: string;
    rate: string;
    effectiveFrom: string;
    verificationNote?: string | null;
    userId: string | null;
    now: Date;
  },
): Promise<TaxCodeRate | undefined> {
  const [row] = await tx
    .insert(taxCodeRates)
    .values({
      organizationId: input.organizationId,
      taxCodeId: input.taxCodeId,
      rate: input.rate,
      effectiveFrom: input.effectiveFrom,
      verificationNote: input.verificationNote ?? null,
      createdByUserId: input.userId,
      createdAt: input.now,
    })
    .onConflictDoNothing()
    .returning();
  return row;
}

export async function deleteTaxCodeRate(
  tx: Transaction,
  organizationId: string,
  taxCodeId: string,
  rateId: string,
): Promise<TaxCodeRate | undefined> {
  const [row] = await tx
    .delete(taxCodeRates)
    .where(
      and(
        eq(taxCodeRates.organizationId, organizationId),
        eq(taxCodeRates.taxCodeId, taxCodeId),
        eq(taxCodeRates.id, rateId),
      ),
    )
    .returning();
  return row;
}

/** The version in effect on a date: the latest one starting on or before it (Decision 15). */
export async function findRateOn(
  tx: Transaction,
  organizationId: string,
  taxCodeId: string,
  onDate: string,
): Promise<TaxCodeRate | undefined> {
  const [row] = await tx
    .select()
    .from(taxCodeRates)
    .where(
      and(
        eq(taxCodeRates.organizationId, organizationId),
        eq(taxCodeRates.taxCodeId, taxCodeId),
        lte(taxCodeRates.effectiveFrom, onDate),
      ),
    )
    .orderBy(desc(taxCodeRates.effectiveFrom))
    .limit(1);
  return row;
}

/**
 * The Maldives localization seed (Decisions 44, 60; Phase 3B D4) for an organization set up from
 * the `maldives` chart: General GST 8% from 2023-01-01, Tourism GST 16% from 2023-01-01 and 17%
 * from 2025-07-01, on account 2130, marked for MIRA verification. Idempotent; returns how many
 * codes were created. The same data is backfilled for existing organizations by migration 0020.
 */
export async function seedLocalizationTaxCodes(
  tx: Transaction,
  input: { organizationId: string; templateKey: string; now: Date },
): Promise<number> {
  if (input.templateKey !== 'maldives') return 0;
  const found = await findAccountByCode(tx, input.organizationId, '2130');
  const account =
    found &&
    found.accountType === 'LIABILITY' &&
    found.status === 'ACTIVE' &&
    !(await hasChildAccounts(tx, input.organizationId, found.id))
      ? found
      : undefined;
  if (!account) return 0;
  const seed = [
    {
      code: 'GST',
      name: 'General GST',
      description: 'Maldives general goods and services tax.',
      rates: [{ rate: '8', effectiveFrom: '2023-01-01' }],
    },
    {
      code: 'TGST',
      name: 'Tourism GST',
      description: 'Maldives tourism goods and services tax.',
      rates: [
        { rate: '16', effectiveFrom: '2023-01-01' },
        { rate: '17', effectiveFrom: '2025-07-01' },
      ],
    },
  ];
  let created = 0;
  for (const item of seed) {
    const code = await insertTaxCode(tx, {
      organizationId: input.organizationId,
      code: item.code,
      name: item.name,
      description: item.description,
      taxAccountId: account.id,
      userId: null,
      now: input.now,
    });
    if (!code) continue;
    created += 1;
    for (const rate of item.rates) {
      await insertTaxCodeRate(tx, {
        organizationId: input.organizationId,
        taxCodeId: code.id,
        rate: rate.rate,
        effectiveFrom: rate.effectiveFrom,
        verificationNote: MIRA_VERIFICATION_NOTE,
        userId: null,
        now: input.now,
      });
    }
  }
  return created;
}
