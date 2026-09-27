import { and, asc, desc, eq, gte, lte } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';
import type { PeriodRange } from './rules.js';
import { accountingFiscalYears, accountingPeriods } from './schema.js';

export type FiscalYear = typeof accountingFiscalYears.$inferSelect;
export type Period = typeof accountingPeriods.$inferSelect;

export async function listFiscalYears(
  tx: Transaction,
  organizationId: string,
): Promise<FiscalYear[]> {
  return tx
    .select()
    .from(accountingFiscalYears)
    .where(eq(accountingFiscalYears.organizationId, organizationId))
    .orderBy(asc(accountingFiscalYears.startDate));
}

export async function getFiscalYear(tx: Transaction, organizationId: string, id: string) {
  const [row] = await tx
    .select()
    .from(accountingFiscalYears)
    .where(
      and(
        eq(accountingFiscalYears.organizationId, organizationId),
        eq(accountingFiscalYears.id, id),
      ),
    )
    .limit(1);
  return row;
}

/** Creates a fiscal year and its periods. Overlaps are also rejected by exclusion constraints. */
export async function createFiscalYear(
  tx: Transaction,
  input: {
    organizationId: string;
    name: string;
    startDate: string;
    endDate: string;
    periods: readonly (PeriodRange & { name: string })[];
    userId: string;
  },
): Promise<{ fiscalYear: FiscalYear; periods: Period[] } | 'name_taken'> {
  const [fiscalYear] = await tx
    .insert(accountingFiscalYears)
    .values({
      organizationId: input.organizationId,
      name: input.name.trim(),
      startDate: input.startDate,
      endDate: input.endDate,
      createdByUserId: input.userId,
    })
    .onConflictDoNothing({
      target: [accountingFiscalYears.organizationId, accountingFiscalYears.name],
    })
    .returning();
  if (!fiscalYear) return 'name_taken';
  const periods = await tx
    .insert(accountingPeriods)
    .values(
      input.periods.map((p, i) => ({
        organizationId: input.organizationId,
        fiscalYearId: fiscalYear.id,
        periodNumber: i + 1,
        name: p.name,
        startDate: p.startDate,
        endDate: p.endDate,
      })),
    )
    .returning();
  return { fiscalYear, periods: periods.sort((a, b) => a.periodNumber - b.periodNumber) };
}

export async function listPeriods(
  tx: Transaction,
  organizationId: string,
  filter: { fiscalYearId?: string | undefined } = {},
): Promise<Period[]> {
  const conditions = [eq(accountingPeriods.organizationId, organizationId)];
  if (filter.fiscalYearId) conditions.push(eq(accountingPeriods.fiscalYearId, filter.fiscalYearId));
  return tx
    .select()
    .from(accountingPeriods)
    .where(and(...conditions))
    .orderBy(asc(accountingPeriods.startDate));
}

export async function getPeriod(
  tx: Transaction,
  organizationId: string,
  periodId: string,
  lock?: 'update' | 'share',
): Promise<Period | undefined> {
  const query = tx
    .select()
    .from(accountingPeriods)
    .where(
      and(eq(accountingPeriods.organizationId, organizationId), eq(accountingPeriods.id, periodId)),
    )
    .limit(1);
  const [row] = lock ? await query.for(lock) : await query;
  return row;
}

/** The journal date determines the accounting period. */
export async function findPeriodForDate(
  tx: Transaction,
  organizationId: string,
  isoDate: string,
  lock?: 'share',
): Promise<Period | undefined> {
  const query = tx
    .select()
    .from(accountingPeriods)
    .where(
      and(
        eq(accountingPeriods.organizationId, organizationId),
        lte(accountingPeriods.startDate, isoDate),
        gte(accountingPeriods.endDate, isoDate),
      ),
    )
    .limit(1);
  const [row] = lock ? await query.for(lock) : await query;
  return row;
}

export async function closePeriod(
  tx: Transaction,
  input: { organizationId: string; periodId: string; userId: string; now: Date },
): Promise<Period | undefined> {
  const [row] = await tx
    .update(accountingPeriods)
    .set({ status: 'CLOSED', closedAt: input.now, closedByUserId: input.userId })
    .where(
      and(
        eq(accountingPeriods.organizationId, input.organizationId),
        eq(accountingPeriods.id, input.periodId),
        eq(accountingPeriods.status, 'OPEN'),
      ),
    )
    .returning();
  return row;
}

export async function reopenPeriod(
  tx: Transaction,
  input: { organizationId: string; periodId: string; userId: string; reason: string; now: Date },
): Promise<Period | undefined> {
  const [row] = await tx
    .update(accountingPeriods)
    .set({
      status: 'OPEN',
      closedAt: null,
      closedByUserId: null,
      reopenedAt: input.now,
      reopenedByUserId: input.userId,
      reopenReason: input.reason,
    })
    .where(
      and(
        eq(accountingPeriods.organizationId, input.organizationId),
        eq(accountingPeriods.id, input.periodId),
        eq(accountingPeriods.status, 'CLOSED'),
      ),
    )
    .returning();
  return row;
}

/** The latest period that contains `today`, or the most recent before it. */
export async function currentPeriod(tx: Transaction, organizationId: string, today: string) {
  const inside = await findPeriodForDate(tx, organizationId, today);
  if (inside) return inside;
  const [latest] = await tx
    .select()
    .from(accountingPeriods)
    .where(
      and(
        eq(accountingPeriods.organizationId, organizationId),
        lte(accountingPeriods.startDate, today),
      ),
    )
    .orderBy(desc(accountingPeriods.startDate))
    .limit(1);
  return latest;
}
