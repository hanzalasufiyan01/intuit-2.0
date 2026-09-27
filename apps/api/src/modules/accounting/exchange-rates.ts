import { and, desc, eq, lte } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';
import { accountingExchangeRates } from './schema.js';

export type ExchangeRate = typeof accountingExchangeRates.$inferSelect;

export async function listExchangeRates(
  tx: Transaction,
  organizationId: string,
  filter: { fromCurrency?: string | undefined; limit: number },
): Promise<ExchangeRate[]> {
  const conditions = [eq(accountingExchangeRates.organizationId, organizationId)];
  if (filter.fromCurrency)
    conditions.push(eq(accountingExchangeRates.fromCurrency, filter.fromCurrency));
  return tx
    .select()
    .from(accountingExchangeRates)
    .where(and(...conditions))
    .orderBy(desc(accountingExchangeRates.rateDate), accountingExchangeRates.fromCurrency)
    .limit(filter.limit);
}

/** Records a rate (1 fromCurrency = rate base units). Returns undefined if that date exists. */
export async function recordExchangeRate(
  tx: Transaction,
  input: {
    organizationId: string;
    fromCurrency: string;
    toCurrency: string;
    rateDate: string;
    rate: string;
    userId: string;
  },
): Promise<ExchangeRate | undefined> {
  const [row] = await tx
    .insert(accountingExchangeRates)
    .values({
      organizationId: input.organizationId,
      fromCurrency: input.fromCurrency,
      toCurrency: input.toCurrency,
      rateDate: input.rateDate,
      rate: input.rate,
      createdByUserId: input.userId,
    })
    .onConflictDoNothing()
    .returning();
  return row;
}

/** Applicable rate: the most recent table rate on or before the journal date. */
export async function findApplicableRate(
  tx: Transaction,
  input: { organizationId: string; fromCurrency: string; toCurrency: string; onDate: string },
): Promise<ExchangeRate | undefined> {
  const [row] = await tx
    .select()
    .from(accountingExchangeRates)
    .where(
      and(
        eq(accountingExchangeRates.organizationId, input.organizationId),
        eq(accountingExchangeRates.fromCurrency, input.fromCurrency),
        eq(accountingExchangeRates.toCurrency, input.toCurrency),
        lte(accountingExchangeRates.rateDate, input.onDate),
      ),
    )
    .orderBy(desc(accountingExchangeRates.rateDate))
    .limit(1);
  return row;
}
