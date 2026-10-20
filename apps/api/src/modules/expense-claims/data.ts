import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';
import { likeContains } from '../catalog/index.js';
import {
  expenseClaimLines,
  expenseClaimNumberSequences,
  expenseClaimSettings,
  expenseClaims,
  type ClaimStatus,
} from './schema.js';

/** Expense claim data access. Rules live in the application service. */

export type ExpenseClaim = typeof expenseClaims.$inferSelect;
export type ExpenseClaimLine = typeof expenseClaimLines.$inferSelect;
export type ClaimSettings = typeof expenseClaimSettings.$inferSelect;
export type ClaimLineValues = Omit<
  typeof expenseClaimLines.$inferInsert,
  'id' | 'organizationId' | 'claimId' | 'lineNo'
>;

const scoped = (organizationId: string, id: string) =>
  and(eq(expenseClaims.organizationId, organizationId), eq(expenseClaims.id, id));

export async function getClaimSettings(
  tx: Transaction,
  organizationId: string,
): Promise<ClaimSettings | undefined> {
  const [row] = await tx
    .select()
    .from(expenseClaimSettings)
    .where(eq(expenseClaimSettings.organizationId, organizationId));
  return row;
}

export async function saveClaimSettings(
  tx: Transaction,
  input: {
    organizationId: string;
    version: number;
    defaultExpenseAccountId: string | null;
    receiptRequiredOver: string | null;
    userId: string;
    at: Date;
  },
): Promise<ClaimSettings | undefined> {
  const values = {
    defaultExpenseAccountId: input.defaultExpenseAccountId,
    receiptRequiredOver: input.receiptRequiredOver,
    updatedByUserId: input.userId,
    updatedAt: input.at,
  };
  if (input.version === 0) {
    const [row] = await tx
      .insert(expenseClaimSettings)
      .values({ organizationId: input.organizationId, ...values })
      .onConflictDoNothing()
      .returning();
    return row;
  }
  const [row] = await tx
    .update(expenseClaimSettings)
    .set({ ...values, version: sql`${expenseClaimSettings.version} + 1` })
    .where(
      and(
        eq(expenseClaimSettings.organizationId, input.organizationId),
        eq(expenseClaimSettings.version, input.version),
      ),
    )
    .returning();
  return row;
}

export async function getClaim(
  tx: Transaction,
  organizationId: string,
  id: string,
  options: { forUpdate?: boolean } = {},
): Promise<ExpenseClaim | undefined> {
  const query = tx.select().from(expenseClaims).where(scoped(organizationId, id));
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row;
}

export async function getClaimLines(
  tx: Transaction,
  organizationId: string,
  claimId: string,
): Promise<ExpenseClaimLine[]> {
  return tx
    .select()
    .from(expenseClaimLines)
    .where(
      and(
        eq(expenseClaimLines.organizationId, organizationId),
        eq(expenseClaimLines.claimId, claimId),
      ),
    )
    .orderBy(asc(expenseClaimLines.lineNo));
}

export async function insertClaim(
  tx: Transaction,
  values: typeof expenseClaims.$inferInsert,
): Promise<ExpenseClaim> {
  const [row] = await tx.insert(expenseClaims).values(values).returning();
  return row!;
}

export async function updateClaim(
  tx: Transaction,
  input: {
    organizationId: string;
    id: string;
    from: ClaimStatus | readonly ClaimStatus[];
    version?: number | undefined;
    set: Partial<typeof expenseClaims.$inferInsert>;
  },
): Promise<ExpenseClaim | undefined> {
  const from = typeof input.from === 'string' ? [input.from] : [...input.from];
  const [row] = await tx
    .update(expenseClaims)
    .set({ ...input.set, version: sql`${expenseClaims.version} + 1` })
    .where(
      and(
        scoped(input.organizationId, input.id),
        inArray(expenseClaims.status, from),
        input.version === undefined ? undefined : eq(expenseClaims.version, input.version),
      ),
    )
    .returning();
  return row;
}

export async function replaceClaimLines(
  tx: Transaction,
  organizationId: string,
  claimId: string,
  lines: readonly ClaimLineValues[],
): Promise<ExpenseClaimLine[]> {
  await tx
    .delete(expenseClaimLines)
    .where(
      and(
        eq(expenseClaimLines.organizationId, organizationId),
        eq(expenseClaimLines.claimId, claimId),
      ),
    );
  if (!lines.length) return [];
  return tx
    .insert(expenseClaimLines)
    .values(lines.map((l, i) => ({ ...l, organizationId, claimId, lineNo: i + 1 })))
    .returning();
}

export async function deleteClaim(tx: Transaction, organizationId: string, id: string) {
  const [row] = await tx
    .delete(expenseClaims)
    .where(and(scoped(organizationId, id), eq(expenseClaims.status, 'DRAFT')))
    .returning({ id: expenseClaims.id });
  return row !== undefined;
}

export async function claimNumberExists(tx: Transaction, organizationId: string, number: string) {
  const [row] = await tx
    .select({ id: expenseClaims.id })
    .from(expenseClaims)
    .where(and(eq(expenseClaims.organizationId, organizationId), eq(expenseClaims.number, number)))
    .limit(1);
  return row !== undefined;
}

export async function takeNextClaimNumber(
  tx: Transaction,
  organizationId: string,
): Promise<string> {
  await tx
    .insert(expenseClaimNumberSequences)
    .values({ organizationId, documentType: 'claim', prefix: 'EC-' })
    .onConflictDoNothing();
  const [row] = await tx
    .update(expenseClaimNumberSequences)
    .set({ nextNumber: sql`${expenseClaimNumberSequences.nextNumber} + 1` })
    .where(
      and(
        eq(expenseClaimNumberSequences.organizationId, organizationId),
        eq(expenseClaimNumberSequences.documentType, 'claim'),
      ),
    )
    .returning();
  const value = BigInt(row!.nextNumber) - 1n;
  return `${row!.prefix}${value.toString().padStart(row!.minDigits, '0')}`;
}

export interface ClaimListQuery {
  organizationId: string;
  statuses: readonly ClaimStatus[] | null;
  employeePartyId: string | null;
  search: string | null;
  employeeIdsIn?: SQL | undefined;
  limit: number;
  after: { date: string; id: string } | null;
}

export async function listClaims(tx: Transaction, query: ClaimListQuery) {
  const t = expenseClaims;
  const conditions: (SQL | undefined)[] = [eq(t.organizationId, query.organizationId)];
  if (query.statuses) conditions.push(inArray(t.status, [...query.statuses]));
  if (query.employeePartyId) conditions.push(eq(t.employeePartyId, query.employeePartyId));
  if (query.search) {
    const pattern = likeContains(query.search);
    conditions.push(
      or(
        ilike(t.number, pattern),
        query.employeeIdsIn ? sql`${t.employeePartyId} IN (${query.employeeIdsIn})` : undefined,
      ),
    );
  }
  if (query.after) {
    conditions.push(
      sql`(${t.claimDate}, ${t.id}) < (${query.after.date}::date, ${query.after.id}::uuid)`,
    );
  }
  const rows = await tx
    .select()
    .from(t)
    .where(and(...conditions))
    .orderBy(desc(t.claimDate), desc(t.id))
    .limit(query.limit + 1);
  return { items: rows.slice(0, query.limit), hasMore: rows.length > query.limit };
}

/** Claim totals per claimant (the employee party) for claim dates in a range; cancelled and draft claims are left out. */
export async function claimantTotals(
  tx: Transaction,
  organizationId: string,
  range: { from: string; to: string },
) {
  const result = await tx.execute<{
    party_id: string;
    display_name: string;
    status: string;
    claims: number;
    total: string;
  }>(sql`
    SELECT c.employee_party_id AS party_id, p.display_name, c.status,
           count(*)::int AS claims, coalesce(sum(c.total), 0)::text AS total
      FROM expense_claims c
      JOIN parties p ON p.id = c.employee_party_id AND p.organization_id = c.organization_id
     WHERE c.organization_id = ${organizationId}
       AND c.claim_date BETWEEN ${range.from}::date AND ${range.to}::date
       AND c.status IN ('PENDING_APPROVAL', 'APPROVED', 'POSTED')
     GROUP BY c.employee_party_id, p.display_name, c.status
     ORDER BY p.display_name, c.status`);
  return result.rows.map((r) => ({
    partyId: r.party_id,
    displayName: r.display_name,
    status: r.status,
    claims: r.claims,
    total: r.total,
  }));
}
